use statglass_engine::{BACKGROUND_TICK_MS, HistoryStore, HistoryStoreError, RECENT_ROWS_MS};
use statglass_proto::{
    Answer, CodecError, ErrorCode, HistoryAnswer, HistoryClamp, HistoryQuery, Message, WireEvent,
    WireHistorySeries, WireSeriesStats, encode_message,
};
use statglass_schema::{Catalog, HostId, SeriesKey, TimeRange, floor_to, is_js_safe};
use statglass_store::{
    BucketRow, HistoryQuery as StoreQuery, HistoryResult, StoreError, TierChoice, range_stats,
    tier_budget::tier_for_budget,
};

use super::{
    HISTORY_MAX_ANSWER_BYTES, HISTORY_MAX_CORE_SERIES, HISTORY_MAX_EVENTS, HISTORY_MAX_POINTS,
    HISTORY_MAX_SERIES, HistoryGrid,
};
use crate::{HostServer, ServedHost};

#[derive(Debug, thiserror::Error)]
enum HistoryQueryError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] HistoryStoreError),
    #[error("encoding the history answer: {0}")]
    Encode(#[from] CodecError),
    #[error("The history metadata exceeds the reply size limit")]
    Oversize,
    #[error("The encoded reply was not a history answer")]
    ReplyShape,
}

impl HistoryQueryError {
    fn into_answer(self) -> Answer {
        let code = match &self {
            Self::Invalid(_) => ErrorCode::InvalidArgument,
            Self::Store(HistoryStoreError::Store(e)) if e.is_busy() => ErrorCode::Busy,
            Self::Store(HistoryStoreError::Store(e)) if e.is_corrupt_database() => {
                ErrorCode::HistoryUnavailable
            }
            Self::Store(
                HistoryStoreError::Unavailable { .. }
                | HistoryStoreError::Store(StoreError::WriterGone),
            ) => ErrorCode::HistoryUnavailable,
            _ => ErrorCode::Internal,
        };
        Answer::Error {
            code,
            message: self.to_string(),
        }
    }
}

type Result<T> = std::result::Result<T, HistoryQueryError>;

pub(super) fn answer<H: ServedHost>(
    server: &HostServer<H>,
    query: &HistoryQuery,
) -> (Answer, Option<HistoryGrid>) {
    let host = server.host().record().id;
    let hub = server.host().hub();
    let now = statglass_engine::wall_ms();
    let interval_ms = hub.status().interval_ms;
    let running = interval_ms > 0 || hub.latest_frame().is_some();
    read_history(
        server.history(),
        host,
        query,
        now,
        now.saturating_sub(i64::from(if interval_ms == 0 {
            BACKGROUND_TICK_MS
        } else {
            interval_ms
        })),
        |from, to| {
            let rows = hub.recent_rows(host, from, to);
            (running || !rows.is_empty()).then_some(rows)
        },
        |key, width, from| hub.history_hold_ms(key, width, from),
    )
    .unwrap_or_else(|error| (error.into_answer(), None))
}

fn read_history(
    store: &HistoryStore,
    host: HostId,
    query: &HistoryQuery,
    now: i64,
    closed_before: i64,
    recent: impl Fn(i64, i64) -> Option<Vec<BucketRow>>,
    hold: impl Fn(&SeriesKey, i64, i64) -> i64,
) -> Result<(Answer, Option<HistoryGrid>)> {
    let catalog = Catalog::builtin();
    let (mut q, mut clamped, series_limit) = bounded_query(query, &catalog, host, now)?;
    let (snapshot, mut events, complete_to_ms, grid) = store.with_history_snapshot(|reader| {
        let coverage = reader.history_tier_coverage(host, q.to_ms)?;
        let tier = tier_for_budget(q.from_ms, q.to_ms, q.max_points, coverage);
        q.tier = TierChoice::Fixed(tier);
        let grid = HistoryGrid::for_tier(tier, q.from_ms, q.to_ms);
        if let Some(grid) = &grid {
            let snapped = grid.query(query);
            q.from_ms = snapped.from_ms;
            q.to_ms = snapped.to_ms.unwrap_or(q.to_ms);
        }
        let events = match query.events_for {
            Some(module) => reader.event_rows(
                host,
                q.from_ms,
                q.to_ms,
                HISTORY_MAX_EVENTS + 1,
                module,
                &catalog,
            )?,
            None => Vec::new(),
        };
        let mut complete_to_ms = None;
        let snapshot = reader.history_snapshot(&q, Some(series_limit), |grid| {
            let from = grid.recent_base.max(now - RECENT_ROWS_MS);
            let rows = recent(from, q.to_ms.min(now));
            if rows.is_some() {
                complete_to_ms = Some(
                    q.to_ms
                        .min(floor_to(closed_before, grid.recent_width))
                        .max(q.from_ms),
                );
            }
            rows.unwrap_or_default()
        })?;
        Ok((snapshot, events, complete_to_ms, grid))
    })?;
    if events.len() > HISTORY_MAX_EVENTS {
        events.remove(0);
        clamped.push(HistoryClamp::Events);
    }
    if snapshot.series_clamped() && !clamped.contains(&HistoryClamp::Series) {
        clamped.push(HistoryClamp::Series);
    }
    let (mut read, durable_to_ms) = snapshot
        .merge_chart(q.max_points, closed_before)
        .map_err(HistoryStoreError::from)?;
    let hold = |key: &SeriesKey, width| hold(key, width, q.from_ms);
    let reply = HistoryAnswer {
        tier: read.tier,
        bucket_ms: read.bucket_ms,
        complete_to_ms: complete_to_ms.unwrap_or(durable_to_ms),
        stats: per_key_stats(&mut read, &q, &catalog, now),
        series: wire_series(&read, &hold),
        gaps: read.gaps,
        events: events
            .into_iter()
            .map(|event| WireEvent {
                source_id: event.source_id,
                seq: event.seq,
                ts_ms: event.ts_ms,
                kind: event.kind,
                payload: event.payload,
            })
            .collect(),
        clamped,
    };
    let answer = bounded_reply(reply, q.max_points, |budget, reply| {
        let (read, _) = snapshot
            .merge_chart(budget, closed_before)
            .map_err(HistoryStoreError::from)?;
        reply.bucket_ms = read.bucket_ms;
        reply.series = wire_series(&read, &hold);
        Ok(())
    })?;
    Ok((answer, grid))
}

fn bounded_query(
    query: &HistoryQuery,
    catalog: &Catalog,
    host: HostId,
    now: i64,
) -> Result<(StoreQuery, Vec<HistoryClamp>, usize)> {
    let requested_to = query.to_ms.unwrap_or(now);
    for (bound, value) in [("from_ms", query.from_ms), ("to_ms", requested_to)] {
        if !is_js_safe(value) {
            return Err(HistoryQueryError::Invalid(format!(
                "History {bound} timestamp {value} is outside the ±2^53 limit (exclusive)"
            )));
        }
    }
    let range = TimeRange::new(query.from_ms, requested_to.min(now), i64::MAX)
        .map_err(|error| HistoryQueryError::Invalid(error.to_string()))?;
    if query.series.is_empty() {
        return Err(HistoryQueryError::Invalid(
            "Select at least one history series".into(),
        ));
    }
    for selector in &query.series {
        if catalog.get(selector.metric.as_str()).is_none() {
            let metric: String = selector.metric.as_str().escape_debug().take(64).collect();
            return Err(HistoryQueryError::Invalid(format!(
                "Unknown history metric {metric}"
            )));
        }
    }
    let series_limit = if query.series.iter().all(|s| s.metric.as_str() == "cpu.load") {
        HISTORY_MAX_CORE_SERIES
    } else {
        HISTORY_MAX_SERIES
    };
    let max_points = query.max_points.clamp(1, HISTORY_MAX_POINTS);
    let mut clamped = Vec::new();
    if max_points != query.max_points {
        clamped.push(HistoryClamp::Points);
    }
    if query.series.len() > series_limit {
        clamped.push(HistoryClamp::Series);
    }
    Ok((
        StoreQuery {
            host,
            selectors: query.series.iter().take(series_limit).cloned().collect(),
            from_ms: range.from_ms(),
            to_ms: range.to_ms(),
            tier: TierChoice::Auto,
            max_points,
        },
        clamped,
        series_limit,
    ))
}

fn per_key_stats(
    read: &mut HistoryResult,
    query: &StoreQuery,
    catalog: &Catalog,
    now: i64,
) -> Vec<WireSeriesStats> {
    let series = std::mem::take(&mut read.series);
    let mut restored = Vec::with_capacity(series.len());
    let mut stats = Vec::with_capacity(series.len());
    for item in series {
        let key = item.key.clone();
        read.series.push(item);
        if let Some(def) = catalog.get(key.metric.as_str()) {
            let result = range_stats(read, &[def], query.from_ms, query.to_ms, now);
            if let Some(stat) = result.metrics.first() {
                stats.push(WireSeriesStats {
                    key,
                    avg: stat.avg.map(|n| n as f32),
                    peak: stat.max.map(|n| n as f32),
                    measured_ms: Some(stat.measured_ms),
                    integral: (stat.measured_ms > 0).then_some(stat.integral),
                });
            }
        }
        restored.append(&mut read.series);
    }
    read.series = restored;
    stats
}

fn wire_series(
    read: &HistoryResult,
    hold: &impl Fn(&SeriesKey, i64) -> i64,
) -> Vec<WireHistorySeries> {
    read.series
        .iter()
        .map(|s| WireHistorySeries {
            key: s.key.clone(),
            hold_ms: hold(&s.key, read.bucket_ms),
            points: s
                .points
                .iter()
                .map(|p| (p.t, p.avg, p.min, p.max))
                .collect(),
        })
        .collect()
}

fn bounded_reply(
    mut reply: HistoryAnswer,
    mut budget: u32,
    remerge: impl Fn(u32, &mut HistoryAnswer) -> Result<()>,
) -> Result<Answer> {
    loop {
        // Bound the complete frame, allowing for the largest possible request id.
        let message = Message::Reply {
            id: u32::MAX,
            answer: Answer::History(reply),
        };
        let bytes = encode_message(&message)?.len() + 4;
        let Message::Reply {
            answer: Answer::History(answer),
            ..
        } = message
        else {
            return Err(HistoryQueryError::ReplyShape);
        };
        reply = answer;
        if bytes <= HISTORY_MAX_ANSWER_BYTES {
            return Ok(Answer::History(reply));
        }
        if !reply.clamped.contains(&HistoryClamp::Bytes) {
            reply.clamped.push(HistoryClamp::Bytes);
        }
        if budget > 1 {
            budget /= 2;
            remerge(budget, &mut reply)?;
        } else if !reply.events.is_empty() {
            // Prefer recent events when metadata alone is too large at one point.
            let discard = reply.events.len().div_ceil(2);
            reply.events.drain(..discard);
            if !reply.clamped.contains(&HistoryClamp::Events) {
                reply.clamped.push(HistoryClamp::Events);
            }
        } else {
            return Err(HistoryQueryError::Oversize);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_query::history_seed::{host_record, seed_by_retention};
    use statglass_schema::{Gap, GapReason, Module, SeriesSelector, Tier};
    use std::cell::Cell;
    use std::sync::Arc;

    #[test]
    fn history_maps_a_busy_sqlite_reader_to_a_retryable_answer() {
        use statglass_store::rusqlite::{Error, ffi};
        let error = StoreError::Sqlite(Error::SqliteFailure(
            ffi::Error::new(ffi::SQLITE_BUSY),
            None,
        ));
        let answer = HistoryQueryError::from(HistoryStoreError::from(error)).into_answer();
        assert!(matches!(
            answer,
            Answer::Error {
                code: ErrorCode::Busy,
                ..
            }
        ));
    }

    #[test]
    fn history_does_not_omit_gaps_to_fit_the_transport_limit() {
        let gaps = (0_i64..30_000)
            .map(|i| statglass_schema::Gap::module_disabled(2 * i, Some(2 * i + 1), Module::Cpu))
            .collect();
        let reply = HistoryAnswer {
            tier: Tier::S10,
            bucket_ms: 10_000,
            complete_to_ms: 0,
            series: Vec::new(),
            gaps,
            events: Vec::new(),
            stats: Vec::new(),
            clamped: Vec::new(),
        };
        let error = bounded_reply(reply, 1, |_, _| panic!("already at one point")).unwrap_err();
        assert!(matches!(error, HistoryQueryError::Oversize));
        let bytes = encode_message(&Message::Reply {
            id: 1,
            answer: error.into_answer(),
        })
        .unwrap();
        assert!(bytes.len() < HISTORY_MAX_ANSWER_BYTES);
    }

    #[test]
    fn history_watermark_uses_time_even_without_matching_samples() {
        let minute = 1_791_158_460_000;
        let now = minute + 1_500;
        let host = host_record();
        let dir = tempfile::tempdir().unwrap();
        let store = HistoryStore::open(dir.path());
        let writer = store.register_host(&host).unwrap();
        let cpu = SeriesKey::parse("cpu.total").unwrap();
        let row = |tier, bucket_ts| BucketRow {
            host: host.id,
            tier,
            bucket_ts,
            series: Arc::from([cpu.clone()]),
            stats: vec![10.0, 30.0, 20.0],
        };
        writer
            .write_gap(
                host.id,
                Gap::host(minute - 100_000, Some(minute - 20_000), GapReason::Sleep).unwrap(),
            )
            .unwrap();
        writer
            .write_gap(
                host.id,
                Gap::module_disabled(minute - 200_000, None, Module::Memory),
            )
            .unwrap();
        writer
            .write_bucket(row(Tier::S10, minute - 150_000))
            .unwrap();
        writer.flush().unwrap();
        let mut q = HistoryQuery {
            series: vec![SeriesSelector {
                metric: cpu.metric.clone(),
                labels: cpu.labels.clone(),
            }],
            from_ms: minute - 200_000,
            to_ms: None,
            max_points: 200,
            events_for: None,
        };
        let run = |q: &HistoryQuery, now: i64, rows: Option<Vec<BucketRow>>| {
            let (answer, _) = read_history(
                &store,
                host.id,
                q,
                now,
                now - 1_000,
                |_, _| rows.clone(),
                |_, width, _| width,
            )
            .unwrap();
            let Answer::History(answer) = answer else {
                panic!("expected history")
            };
            (answer.tier, answer.complete_to_ms)
        };
        // Available but empty recent history, unavailable recent history, and a bucket
        // at the sampler boundary all have different completeness implications.
        let mut disabled_query = q.clone();
        disabled_query.series[0].metric = statglass_schema::MetricId::from_static("mem.used");
        let disabled = run(&disabled_query, now, Some(vec![]));
        let fallback = run(&q, now, None);
        let boundary = run(&q, minute + 500, Some(vec![row(Tier::S10, minute)]));
        let open_from = minute + 100;
        let open_query = HistoryQuery {
            from_ms: open_from,
            ..q.clone()
        };
        let inside_open_bucket = run(&open_query, minute + 500, Some(vec![]));
        q.to_ms = Some(minute - 70_000);
        let ending_in_gap = run(&q, now, Some(vec![]));
        q.from_ms = minute - 7_200_000;
        q.to_ms = None;
        q.max_points = 1;
        let slow = run(&q, now, Some(vec![row(Tier::M1, minute - 180_000)]));
        assert_eq!(
            [
                disabled,
                fallback,
                boundary,
                inside_open_bucket,
                ending_in_gap,
                slow
            ],
            [
                (Tier::S10, minute),
                (Tier::S10, minute - 140_000),
                (Tier::S10, minute - 10_000),
                (Tier::S10, open_from),
                (Tier::S10, minute - 70_000),
                (Tier::M15, floor_to(minute, 900_000)),
            ],
        );
    }

    #[test]
    fn history_uses_one_bounded_recent_snapshot_to_close_the_commit_hole() {
        const BUCKET: i64 = 10_000;
        let current_bucket = 1_791_158_400_000;
        let now = current_bucket + 1_500;
        let host = host_record();
        let key = SeriesKey::parse("cpu.total").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let durable_to = current_bucket - 300_000;
        let store = seed_by_retention(dir.path(), std::slice::from_ref(&key), durable_to);
        let writer = store.writer().unwrap();
        let series: Arc<[SeriesKey]> = vec![key.clone()].into();
        let row = |bucket_ts| BucketRow {
            host: host.id,
            tier: Tier::S10,
            bucket_ts,
            series: series.clone(),
            stats: vec![20.0, 80.0, 42.0],
        };
        let newest_closed = current_bucket - BUCKET;
        writer.write_bucket(row(newest_closed)).unwrap();
        let selectors = vec![SeriesSelector {
            metric: key.metric,
            labels: key.labels,
        }];
        let persisted = store
            .read(|reader| {
                reader.history(&StoreQuery {
                    host: host.id,
                    selectors: selectors.clone(),
                    from_ms: durable_to,
                    to_ms: now,
                    tier: TierChoice::Fixed(Tier::S10),
                    max_points: 500,
                })
            })
            .unwrap();
        assert!(
            persisted.series.is_empty(),
            "the newest row was queued without a commit"
        );

        for (from_ms, recent_start) in [
            (current_bucket - 3_600_000, now - RECENT_ROWS_MS),
            (newest_closed + 2_000, newest_closed),
        ] {
            let request = HistoryQuery {
                series: selectors.clone(),
                from_ms,
                to_ms: None,
                max_points: 500,
                events_for: None,
            };
            let calls = Cell::new(0);
            let (answer, _) = read_history(
                &store,
                host.id,
                &request,
                now,
                now - 1_000,
                |from, to| {
                    calls.set(calls.get() + 1);
                    assert_eq!((from, to), (recent_start, current_bucket));
                    Some(
                        [newest_closed, current_bucket]
                            .into_iter()
                            .filter(|ts| (from..to).contains(ts))
                            .map(row)
                            .collect(),
                    )
                },
                |_, width, _| width,
            )
            .unwrap();
            let Answer::History(answer) = answer else {
                panic!("expected a history answer")
            };
            assert_eq!(calls.get(), 1);
            assert_eq!(answer.complete_to_ms, current_bucket);
            assert!(
                answer.series[0]
                    .points
                    .contains(&(newest_closed, 42.0, 20.0, 80.0))
            );
            assert_eq!(answer.series[0].points.last().unwrap().0, newest_closed);
        }
    }
}
