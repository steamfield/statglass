//! Query adapters: validate IPC requests, combine persisted and recent values.
use super::*;

/// How far back `last_wake` looks for a sleep.
const LAST_WAKE_SPAN_MS: i64 = 7 * 86_400_000;
impl History {
    /// `query_network_by_app`: the stored tiers plus `recent` (the engine's in-memory
    /// buckets, which replace stored rows of the same bucket), split into apps, overhead
    /// and the remainder. `recent` is called after the stored rows are read, so its
    /// copies are never older than them; `complete_to_ms` comes from the same call and
    /// stops where the engine's buckets stop being final. With the store unavailable,
    /// the ring alone answers (live-only). Blocking.
    pub fn network_by_app(
        &self,
        host: statglass_schema::HostId,
        from_ms: i64,
        to_ms: i64,
        recent: impl FnOnce() -> statglass_engine::RecentNet,
    ) -> Result<NetworkByApp, CommandError> {
        TimeRange::new(from_ms, to_ms, MAX_NET_SPAN_MS)?;
        let (read, complete_to_ms) = self.storage.network_by_app(host, from_ms, to_ms, recent)?;
        let mut out: NetworkByApp = read.into();
        // The engine always has an edge once it has started; before that, nothing is
        // promised final.
        out.complete_to_ms = out
            .complete_to_ms
            .min(complete_to_ms.unwrap_or(out.from_ms));
        Ok(out)
    }

    /// `query_history`: the stored tier plus `recent` (the engine's bucket rows since its
    /// last commit and its open buckets, which replace stored rows of the same bucket and
    /// layout), so history answers through now (D-092). `hold(key, bucket_ms)` is each
    /// series' `hold_ms`. With the store unavailable, the recent rows alone answer
    /// (live-only). Blocking.
    pub fn history(
        &self,
        request: &HistoryRequest,
        recent: impl Fn() -> Vec<BucketRow>,
        hold: impl Fn(&SeriesKey, i64) -> i64,
    ) -> Result<HistoryPage, CommandError> {
        let query = request.to_query()?;
        Ok(history_page(
            self.history_through_now(&query, recent)?,
            hold,
        ))
    }

    /// Bounded disk query. Pairing and operation weighting remain in statglass-store.
    pub fn disk_io(
        &self,
        request: &statglass_schema::disk_io::DiskIoRequest,
        now_ms: i64,
        recent: impl Fn() -> Vec<BucketRow>,
    ) -> Result<statglass_schema::disk_io::DiskIoPage, CommandError> {
        TimeRange::new(request.from_ms, request.to_ms, MAX_NET_SPAN_MS)?;
        if request.from_ms < 0
            || request.to_ms > statglass_schema::JS_SAFE_INT_MAX
            || !(1..=2000).contains(&request.max_points)
            || request.device.as_ref().is_some_and(|dev| {
                dev.is_empty()
                    || dev.len() > 64
                    || !dev
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
        {
            return Err(CommandError::InvalidArgument {
                message: "Disk I/O request exceeds device, range or point bounds".into(),
            });
        }
        let labels = request
            .device
            .as_ref()
            .map_or_else(Labels::new, |dev| Labels::single("dev", dev));
        let query = HistoryQuery {
            host: request.host,
            from_ms: request.from_ms,
            to_ms: request.to_ms,
            tier: TierChoice::Auto,
            max_points: ((request.to_ms - request.from_ms) / 10_000 + 2) as u32,
            selectors: (if request.device.is_some() {
                &statglass_schema::disk_io::DEVICE_METRICS
            } else {
                &statglass_schema::disk_io::TOTAL_METRICS
            })
            .iter()
            .map(|id| statglass_schema::SeriesSelector {
                metric: MetricId::from_static(id),
                labels: labels.clone(),
            })
            .collect(),
        };
        let read = self.history_through_now(&query, recent)?;
        if read.series.len() > 1024 {
            return Err(CommandError::InvalidArgument {
                message: "Select a disk: this range contains more than 128 device identities"
                    .into(),
            });
        }
        Ok(statglass_store::disk_io::disk_io_page(
            read,
            request.device.as_deref(),
            request.from_ms,
            request.to_ms,
            now_ms,
            request.max_points,
        ))
    }

    /// [`Reader::history_after`] with `recent`, called after the stored rows are read so
    /// its copies are never older than them; the recent rows alone when the store is
    /// unavailable. The store can close between a check and the read, so the read's own
    /// `history_unavailable` is what sends this to the recent rows.
    pub(crate) fn history_through_now(
        &self,
        query: &HistoryQuery,
        recent: impl Fn() -> Vec<BucketRow>,
    ) -> Result<HistoryResult, CommandError> {
        Ok(self.storage.history_through_now(query, recent)?)
    }

    /// `query_series_stats`: each unlabelled metric of `metrics` over `[from_ms, to_ms)`
    /// from its rollups, through now as `query_history` reads them: the span-weighted
    /// average (D-092), the largest sample, and the average times the time measured (bytes
    /// for a bytes-per-second metric). A bucket counts the time it covers, cut at
    /// `now_ms`, less any gap inside it that applies to the metric's module; a bucket with
    /// no reading counts nothing. The tier is the one `query_history` would pick.
    /// Blocking.
    pub fn series_stats(
        &self,
        host: statglass_schema::HostId,
        metrics: &[String],
        from_ms: i64,
        to_ms: i64,
        now_ms: i64,
        recent: impl Fn() -> Vec<BucketRow>,
    ) -> Result<RangeStats, CommandError> {
        TimeRange::new(from_ms, to_ms, MAX_NET_SPAN_MS)?;
        let catalog = statglass_schema::Catalog::builtin();
        let defs = metrics
            .iter()
            .map(|m| match catalog.get(m) {
                Some(d) if d.label_keys.is_empty() => Ok(d),
                Some(_) => Err(CommandError::InvalidArgument {
                    message: format!("{m} has labels; series stats take unlabelled metrics"),
                }),
                None => Err(CommandError::InvalidArgument {
                    message: format!("{m} is not in the catalog"),
                }),
            })
            .collect::<Result<Vec<_>, _>>()?;
        // One point per bucket of the finest tier: no merging.
        let query = per_bucket_query(
            host,
            defs.iter().map(|d| d.id.clone()),
            from_ms,
            to_ms,
            TierChoice::Auto,
            Tier::S10.bucket_ms().unwrap_or(10_000),
        );
        let read = self.history_through_now(&query, recent)?;
        Ok(statglass_store::range_stats(
            &read, &defs, from_ms, to_ms, now_ms,
        ))
    }

    /// `last_wake`: the end of the latest closed sleep gap of `host` in the week before
    /// `now_ms`; `None` when it did not sleep in that week, and `history_unavailable`
    /// without stored history, which keeps the gaps. Blocking.
    pub fn last_wake(
        &self,
        host: statglass_schema::HostId,
        now_ms: i64,
    ) -> Result<Option<i64>, CommandError> {
        let gaps = self.read(|r| r.gaps(host, now_ms - LAST_WAKE_SPAN_MS, now_ms + 1))?;
        Ok(gaps
            .into_iter()
            .filter(|g| g.reason == statglass_schema::GapReason::Sleep)
            .filter_map(|g| g.end_ms)
            .max())
    }
}
/// A read of the unlabelled `metrics` with room for one point per `bucket_ms` bucket of
/// `[from_ms, to_ms)`, so none are merged.
fn per_bucket_query(
    host: statglass_schema::HostId,
    metrics: impl IntoIterator<Item = MetricId>,
    from_ms: i64,
    to_ms: i64,
    tier: TierChoice,
    bucket_ms: i64,
) -> HistoryQuery {
    HistoryQuery {
        host,
        selectors: metrics
            .into_iter()
            .map(|metric| statglass_schema::SeriesSelector {
                metric,
                labels: Labels::new(),
            })
            .collect(),
        from_ms,
        to_ms,
        tier,
        max_points: u32::try_from((to_ms - from_ms) / bucket_ms + 2).unwrap_or(u32::MAX),
    }
}
