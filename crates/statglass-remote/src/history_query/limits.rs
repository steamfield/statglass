use std::{
    borrow::Cow,
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use statglass_engine::HistoryStore;
use statglass_proto::{Answer, ErrorCode, HistoryAnswer, HistoryQuery};
use statglass_schema::{Tier, TimeRange, floor_to, is_js_safe, lock::LockExt};
use statglass_store::HistoryCacheEpoch;
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError},
    time::Instant,
};

pub const HISTORY_MAX_CONCURRENT: usize = 2;
pub const HISTORY_CACHE_TTL: Duration = Duration::from_secs(10);
const HISTORY_CACHE_ENTRIES: usize = 16;

/// Per-host limit on history jobs and a short cache of successful answers.
pub struct HistoryLimits {
    reads: Arc<Semaphore>,
    cache: Mutex<VecDeque<CacheEntry>>,
}

struct CacheEntry {
    epoch: HistoryCacheEpoch,
    query: HistoryQuery,
    grid: HistoryGrid,
    answer: Arc<HistoryAnswer>,
    expires: Instant,
}

impl CacheEntry {
    fn matches(&self, query: &HistoryQuery, range: TimeRange) -> bool {
        // Preserve selector order because the read may clamp the list.
        self.query.max_points == query.max_points
            && self.query.events_for == query.events_for
            && self.query.series == query.series
            && snap(range, self.grid.width) == Some(self.grid.bounds)
    }
}

/// The source-tier grid selected by the reader before it scans any history rows.
pub(crate) struct HistoryGrid {
    pub(crate) bounds: TimeRange,
    width: i64,
}

impl HistoryGrid {
    pub(crate) fn for_tier(tier: Tier, from_ms: i64, to_ms: i64) -> Option<Self> {
        if !is_js_safe(from_ms) || !is_js_safe(to_ms) {
            return None;
        }
        let width = tier.bucket_ms()?;
        let bounds = snap(TimeRange::new(from_ms, to_ms, i64::MAX).ok()?, width)?;
        Some(Self { bounds, width })
    }
}

fn snap(range: TimeRange, width: i64) -> Option<TimeRange> {
    let from_ms = floor_to(range.from_ms(), width);
    let to_ms = floor_to(range.to_ms(), width);
    if !is_js_safe(from_ms) || !is_js_safe(to_ms) {
        return None;
    }
    // A range wholly within one source bucket still gets an uncached read.
    TimeRange::new(from_ms, to_ms, i64::MAX).ok()
}

fn effective_range(query: &HistoryQuery, now_ms: i64) -> Option<TimeRange> {
    let requested_end = query.to_ms.unwrap_or(now_ms);
    if !is_js_safe(query.from_ms) || !is_js_safe(requested_end) {
        return None;
    }
    TimeRange::new(query.from_ms, requested_end.min(now_ms), i64::MAX).ok()
}

impl Default for HistoryLimits {
    fn default() -> Self {
        Self {
            reads: Arc::new(Semaphore::new(HISTORY_MAX_CONCURRENT)),
            cache: Mutex::default(),
        }
    }
}

impl HistoryLimits {
    pub(crate) fn try_acquire(&self) -> Result<OwnedSemaphorePermit, TryAcquireError> {
        self.reads.clone().try_acquire_owned()
    }

    pub(crate) fn answer(
        &self,
        store: &HistoryStore,
        query: &HistoryQuery,
        read: impl FnOnce(&HistoryQuery, &mut Option<HistoryGrid>) -> Answer,
    ) -> Answer {
        self.answer_at(store, query, statglass_engine::wall_ms(), read)
    }

    fn answer_at(
        &self,
        store: &HistoryStore,
        query: &HistoryQuery,
        now_ms: i64,
        read: impl FnOnce(&HistoryQuery, &mut Option<HistoryGrid>) -> Answer,
    ) -> Answer {
        let mut grid = None;
        let Some(range) = effective_range(query, now_ms) else {
            return read(query, &mut grid);
        };
        if let Some(answer) = self.cached(query, range) {
            return Answer::History((*answer).clone());
        }
        let epoch = store
            .writer()
            .ok()
            .map(|writer| writer.history_cache_epoch());
        let end_ms = range.to_ms();
        let effective = if query.to_ms == Some(end_ms) {
            Cow::Borrowed(query)
        } else {
            Cow::Owned(HistoryQuery {
                to_ms: Some(end_ms),
                ..query.clone()
            })
        };
        let answer = read(&effective, &mut grid);
        if let Answer::History(history) = &answer
            && let (Some(epoch), Some(grid)) = (epoch, grid)
            && epoch.is_current()
        {
            let entry = CacheEntry {
                epoch,
                query: effective.into_owned(),
                grid,
                answer: Arc::new(history.clone()),
                expires: Instant::now() + HISTORY_CACHE_TTL,
            };
            let mut cache = self.cache.lock_ok();
            cache.retain(|older| older.epoch.is_current() && !older.matches(query, range));
            if cache.len() == HISTORY_CACHE_ENTRIES {
                cache.pop_back();
            }
            cache.push_front(entry);
        }
        answer
    }

    pub(crate) fn cached_answer(&self, query: &HistoryQuery) -> Option<Arc<HistoryAnswer>> {
        self.cached(query, effective_range(query, statglass_engine::wall_ms())?)
    }

    fn cached(&self, query: &HistoryQuery, range: TimeRange) -> Option<Arc<HistoryAnswer>> {
        let mut cache = self.cache.lock_ok();
        let now = Instant::now();
        cache.retain(|entry| entry.epoch.is_current() && now < entry.expires);
        cache
            .iter()
            .find(|entry| entry.matches(query, range))
            .map(|entry| Arc::clone(&entry.answer))
    }
}

pub(crate) fn busy() -> Answer {
    Answer::Error {
        code: ErrorCode::Busy,
        message: "The host is busy with other requests".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HostServer, ServedHost, serve_connection};
    use statglass_engine::LiveHub;
    use statglass_proto::{Message, Offer, Query, RemoteInterest};
    use statglass_schema::{
        Capabilities, Gap, GapReason, HostId, HostRecord, MetricId, Module, OsKind, SeriesSelector,
        Tier,
    };
    use statglass_store::{BucketRow, HistoryQuery as StoreQuery, TierChoice};
    use std::cell::Cell;

    fn query(max_points: u32) -> HistoryQuery {
        HistoryQuery {
            series: vec![SeriesSelector {
                metric: MetricId::parse("cpu.total").expect("valid metric"),
                labels: Default::default(),
            }],
            from_ms: 60_002,
            to_ms: Some(120_002),
            max_points,
            events_for: Some(Module::Cpu),
        }
    }

    fn page(complete_to_ms: i64) -> HistoryAnswer {
        HistoryAnswer {
            tier: Tier::M1,
            bucket_ms: 60_000,
            complete_to_ms,
            series: Vec::new(),
            gaps: Vec::new(),
            events: Vec::new(),
            stats: Vec::new(),
            clamped: Vec::new(),
        }
    }

    fn read_on_grid(
        read: impl FnOnce(&HistoryQuery) -> Answer,
    ) -> impl FnOnce(&HistoryQuery, &mut Option<HistoryGrid>) -> Answer {
        move |query, grid| {
            *grid = query
                .to_ms
                .and_then(|to| HistoryGrid::for_tier(Tier::M1, query.from_ms, to));
            let snapped = grid.as_ref().map(|grid| HistoryQuery {
                from_ms: grid.bounds.from_ms(),
                to_ms: Some(grid.bounds.to_ms()),
                ..query.clone()
            });
            read(snapped.as_ref().unwrap_or(query))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn rolling_history_uses_one_snapped_read_until_expiry() {
        let dir = tempfile::tempdir().expect("test history directory");
        let store = HistoryStore::open(dir.path());
        let host = crate::test_support::bare_host(1, "Test host", OsKind::Linux);
        let writer = store.register_host(&host).expect("register test host");
        let key = statglass_schema::SeriesKey::parse("cpu.total").expect("valid series");
        for bucket_ts in [0, 60_000, 120_000] {
            writer
                .write_bucket(BucketRow {
                    host: host.id,
                    tier: Tier::M1,
                    bucket_ts,
                    series: vec![key.clone()].into(),
                    stats: vec![1.0; 3],
                })
                .expect("write test history");
        }
        writer.flush().expect("commit test history");
        let first = HistoryLimits::default();
        let second = HistoryLimits::default();
        let reads = Cell::new(0);
        let read = |q: &HistoryQuery| {
            assert_eq!((q.from_ms, q.to_ms), (60_000, Some(120_000)));
            let result = store
                .read(|reader| {
                    reader.history(&StoreQuery {
                        host: host.id,
                        selectors: q.series.clone(),
                        from_ms: q.from_ms,
                        to_ms: q.to_ms.expect("effective end"),
                        tier: TierChoice::Fixed(Tier::M1),
                        max_points: q.max_points,
                    })
                })
                .expect("read history");
            reads.set(reads.get() + 1);
            let mut answer = page(120_000);
            answer.series = result
                .series
                .into_iter()
                .map(|series| statglass_proto::WireHistorySeries {
                    key: series.key,
                    hold_ms: 60_000,
                    points: series
                        .points
                        .into_iter()
                        .map(|p| (p.t, p.avg, p.min, p.max))
                        .collect(),
                })
                .collect();
            Answer::History(answer)
        };
        let original = HistoryQuery {
            to_ms: None,
            ..query(200)
        };
        let same_bucket = HistoryQuery {
            from_ms: original.from_ms + 300,
            ..original.clone()
        };
        let ask =
            |limits: &HistoryLimits, q, now| limits.answer_at(&store, q, now, read_on_grid(read));
        let mut expected = page(120_000);
        expected.series.push(statglass_proto::WireHistorySeries {
            key,
            hold_ms: 60_000,
            points: vec![(60_000, 1.0, 1.0, 1.0)],
        });
        let expected = Answer::History(expected);
        assert_eq!(ask(&first, &original, 120_350), expected);
        assert_eq!(ask(&first, &same_bucket, 120_650), expected);
        assert_eq!(reads.get(), 1);
        assert_eq!(ask(&second, &original, 120_650), expected);
        assert_eq!(reads.get(), 2);

        tokio::time::advance(HISTORY_CACHE_TTL - Duration::from_millis(1)).await;
        assert_eq!(ask(&first, &original, 120_650), expected);
        assert_eq!(reads.get(), 2);
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(ask(&first, &original, 120_650), expected);
        assert_eq!(reads.get(), 3);
    }

    #[test]
    fn history_cache_respects_budget_event_module_and_selectors() {
        let dir = tempfile::tempdir().expect("history directory");
        let store = HistoryStore::open(dir.path());
        let limits = HistoryLimits::default();
        let baseline = query(200);
        let first = Answer::History(page(1));
        let second = Answer::History(page(2));
        assert_eq!(
            limits.answer(&store, &baseline, read_on_grid(|_| first.clone())),
            first
        );
        let mut other_series = baseline.series.clone();
        other_series[0].labels = statglass_schema::Labels::single("core", "1");
        for different in [
            query(60),
            HistoryQuery {
                events_for: Some(Module::Gpu),
                ..baseline.clone()
            },
            HistoryQuery {
                series: other_series,
                ..baseline.clone()
            },
        ] {
            assert_eq!(
                limits.answer(&store, &different, read_on_grid(|_| second.clone())),
                second
            );
        }
        assert_eq!(
            limits.answer(&store, &baseline, read_on_grid(|_| second.clone())),
            first
        );
    }

    #[test]
    fn history_cache_cannot_hide_a_range_inverted_after_clamping_to_now() {
        assert!(HistoryGrid::for_tier(Tier::M1, i64::MIN, 120_010).is_none());
        let dir = tempfile::tempdir().expect("history directory");
        let store = HistoryStore::open(dir.path());
        let limits = HistoryLimits::default();
        let valid = HistoryQuery {
            from_ms: 60_000,
            to_ms: Some(120_020),
            ..query(200)
        };
        let invalid = HistoryQuery {
            from_ms: 120_010,
            ..valid.clone()
        };
        let error = Answer::Error {
            code: ErrorCode::InvalidArgument,
            message: "History range must be positive".into(),
        };
        let valid_answer = Answer::History(page(120_000));
        assert_eq!(
            limits.answer_at(
                &store,
                &valid,
                120_010,
                read_on_grid(|q| {
                    assert_eq!(q.to_ms, Some(120_000));
                    valid_answer.clone()
                })
            ),
            valid_answer,
        );
        assert_eq!(
            limits.answer_at(&store, &invalid, 120_010, |_, _| error.clone()),
            error
        );
        let outside_wire_range = HistoryQuery {
            to_ms: Some(i64::MAX),
            ..valid
        };
        assert_eq!(
            limits.answer_at(&store, &outside_wire_range, 120_010, |_, _| error.clone()),
            error
        );
    }

    fn read_gaps(
        store: &HistoryStore,
        host: HostId,
        limits: &HistoryLimits,
        q: &HistoryQuery,
    ) -> Answer {
        limits.answer(
            store,
            q,
            read_on_grid(|q| {
                let end = q.to_ms.expect("effective end");
                let mut answer = page(end);
                answer.gaps = store
                    .read(|r| r.gaps(host, q.from_ms, end))
                    .expect("read history gaps");
                Answer::History(answer)
            }),
        )
    }

    #[test]
    fn history_gaps_and_cache_use_the_same_grid_bounds() {
        let dir = tempfile::tempdir().expect("test history directory");
        let store = HistoryStore::open(dir.path());
        let host = crate::test_support::bare_host(1, "Test host", OsKind::Linux);
        let writer = store.register_host(&host).expect("register host");
        let gap = Gap::host(120_003, Some(120_004), GapReason::Paused).expect("valid gap");
        writer
            .write_gap(host.id, gap)
            .expect("write gap at end of range");
        writer.flush().expect("commit gap");

        let limits = HistoryLimits::default();
        let short = query(200);
        let wide = HistoryQuery {
            to_ms: Some(180_005),
            ..short.clone()
        };
        let same_as_short = HistoryQuery {
            to_ms: Some(120_005),
            ..short.clone()
        };
        let mut full_page = page(180_000);
        full_page.gaps = vec![gap];
        assert_eq!(
            read_gaps(&store, host.id, &limits, &wide),
            Answer::History(full_page)
        );
        assert_eq!(
            read_gaps(&store, host.id, &limits, &short),
            Answer::History(page(120_000))
        );
        assert_eq!(
            read_gaps(&store, host.id, &limits, &same_as_short),
            Answer::History(page(120_000))
        );
    }

    #[test]
    fn history_cache_discards_answers_after_the_store_is_cleared() {
        let dir = tempfile::tempdir().expect("test history directory");
        let store = HistoryStore::open(dir.path());
        let host = crate::test_support::bare_host(1, "Test host", OsKind::Linux);
        let writer = store.register_host(&host).expect("register host");
        let gap = Gap::host(90_000, Some(95_000), GapReason::Paused).expect("valid gap");
        writer.write_gap(host.id, gap).expect("write gap");
        writer.flush().expect("commit gap");

        let limits = HistoryLimits::default();
        let q = query(200);
        let mut before = page(120_000);
        before.gaps = vec![gap];
        assert_eq!(
            read_gaps(&store, host.id, &limits, &q),
            Answer::History(before)
        );
        writer.clear_host(host.id, 120_002).expect("clear history");
        writer.flush().expect("flush the clear");
        assert_eq!(
            read_gaps(&store, host.id, &limits, &q),
            Answer::History(page(120_000))
        );
    }

    struct TestHost {
        record: HostRecord,
        hub: LiveHub,
    }

    impl ServedHost for TestHost {
        fn record(&self) -> HostRecord {
            self.record.clone()
        }

        fn hub(&self) -> &LiveHub {
            &self.hub
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }

        fn set_remote_interest(&self, _: u64, _: RemoteInterest) {}
    }

    #[tokio::test]
    async fn history_replies_use_the_host_cache_on_the_wire() {
        let dir = tempfile::tempdir().expect("test history directory");
        let store = Arc::new(HistoryStore::open(dir.path()));
        let record = crate::test_support::bare_host(1, "Test host", OsKind::Linux);
        let writer = store.register_host(&record).expect("register host");
        let gap = Gap::host(90_000, Some(95_000), GapReason::Paused).expect("valid gap");
        writer.write_gap(record.id, gap).expect("write gap");
        writer.flush().expect("commit gap");

        let host_id = record.id;
        let host = Arc::new(TestHost {
            record,
            hub: LiveHub::default(),
        });
        let server = Arc::new(HostServer::new(host, store.clone()));
        let q = query(200);
        let mut expected = page(120_000);
        expected.gaps = vec![gap];
        let expected = Answer::History(expected);
        // Supply the read through the scaffold seam. The wire requests enter the
        // real HostServer and reuse this page before reaching the stub reader.
        assert_eq!(
            read_gaps(&store, host_id, &server.history_limits, &q),
            expected
        );
        let _busy: Vec<_> = (0..HISTORY_MAX_CONCURRENT)
            .map(|_| {
                server
                    .history_limits
                    .try_acquire()
                    .expect("occupy a host permit")
            })
            .collect();
        let (mut client, peer) = tokio::io::duplex(16 * 1024);
        let session = tokio::spawn(serve_connection(peer, server));
        let exchange = async {
            let Message::Hello(hello) = crate::codec::read(&mut client).await.expect("read Hello")
            else {
                panic!("expected Hello");
            };
            let ack = statglass_proto::negotiate(
                &Offer::local(statglass_proto::local_features()),
                &Offer::from(&*hello),
            )
            .expect("negotiate history")
            .ack();
            crate::codec::write(&mut client, &Message::HelloAck(ack))
                .await
                .expect("write HelloAck");
            assert!(matches!(
                crate::codec::read(&mut client).await,
                Ok(Message::SourceStatus(_))
            ));
            for id in 1..=2 {
                crate::codec::write(
                    &mut client,
                    &Message::Request {
                        id,
                        query: Query::History(q.clone()),
                    },
                )
                .await
                .expect("request history");
                assert_eq!(
                    crate::codec::read(&mut client)
                        .await
                        .expect("receive history"),
                    Message::Reply {
                        id,
                        answer: expected.clone()
                    },
                );
            }
        };
        tokio::time::timeout(Duration::from_secs(5), exchange)
            .await
            .expect("history session must make progress");
        drop(client);
        assert!(session.await.expect("join history session").is_err());
    }

    #[test]
    fn history_cache_keeps_sixteen_entries_and_retries_errors() {
        let dir = tempfile::tempdir().expect("history directory");
        let store = HistoryStore::open(dir.path());
        let limits = HistoryLimits::default();
        let original = Answer::History(page(1));
        let fresh = Answer::History(page(2));
        assert_eq!(
            limits.answer(&store, &query(1), read_on_grid(|_| busy())),
            busy()
        );
        for budget in 1..=17 {
            assert_eq!(
                limits.answer(&store, &query(budget), read_on_grid(|_| original.clone())),
                original
            );
        }
        let mut hits = 0;
        // A miss returns an uncached answer so probing cannot evict another entry.
        for budget in 1..=17 {
            if limits.answer(&store, &query(budget), read_on_grid(|_| Answer::Unknown)) == original
            {
                hits += 1;
            }
        }
        assert_eq!(hits, 16);
        assert_eq!(
            limits.answer(&store, &query(18), read_on_grid(|_| fresh.clone())),
            fresh
        );
    }
}
