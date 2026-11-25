use statglass_engine::{HistoryStore, HistoryStoreError, RECENT_ROWS_MS};
use statglass_proto::{
    Answer, CodecError, ErrorCode, HistoryAnswer, HistoryClamp, HistoryQuery, Message, WireEvent,
    WireHistorySeries, WireSeriesStats, encode_message,
};
use statglass_schema::{Catalog, HostId, Module, SeriesKey, TimeRange, is_js_safe};
use statglass_store::{
    BucketRow, HistoryQuery as StoreQuery, HistoryResult, StoreError, TierChoice, range_stats,
    tier_budget::tier_for_budget,
};

use super::{
    HISTORY_MAX_ANSWER_BYTES, HISTORY_MAX_CORE_SERIES, HISTORY_MAX_EVENTS, HISTORY_MAX_POINTS,
    HISTORY_MAX_SERIES,
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

pub(super) fn answer<H: ServedHost>(server: &HostServer<H>, query: &HistoryQuery) -> Answer {
    let host = server.host().record().id;
    let hub = server.host().hub();
    let now = statglass_engine::wall_ms();
    read_history(
        server.history(),
        host,
        query,
        now,
        |from, to| hub.recent_rows(host, from, to),
        |key, width| hub.history_hold_ms(key, width, query.from_ms),
    )
    .unwrap_or_else(HistoryQueryError::into_answer)
}

fn read_history(
    store: &HistoryStore,
    host: HostId,
    query: &HistoryQuery,
    now: i64,
    recent: impl Fn(i64, i64) -> Vec<BucketRow>,
    hold: impl Fn(&SeriesKey, i64) -> i64,
) -> Result<Answer> {
    let catalog = Catalog::builtin();
    let (mut q, mut clamped, series_limit) = bounded_query(query, &catalog, host, now)?;
    let (snapshot, mut events) = store.history_snapshot(|reader| {
        let coverage = reader.history_tier_coverage(host, q.to_ms)?;
        q.tier = TierChoice::Fixed(tier_for_budget(q.from_ms, q.to_ms, q.max_points, coverage));
        let events = match query.events_for {
            Some(module) => {
                reader.event_rows(host, q.from_ms, q.to_ms, HISTORY_MAX_EVENTS + 1, |event| {
                    event.module(&catalog).is_some_and(|actual| {
                        actual == module || (module == Module::Power && actual == Module::Sensors)
                    })
                })?
            }
            None => Vec::new(),
        };
        let snapshot = reader.history_snapshot(&q, Some(series_limit), || {
            recent(q.from_ms.max(now - RECENT_ROWS_MS), q.to_ms.min(now))
        })?;
        Ok((snapshot, events))
    })?;
    if events.len() > HISTORY_MAX_EVENTS {
        events.remove(0);
        clamped.push(HistoryClamp::Events);
    }
    if snapshot.series_clamped() && !clamped.contains(&HistoryClamp::Series) {
        clamped.push(HistoryClamp::Series);
    }
    let (mut read, complete_to_ms) = snapshot
        .merge(q.max_points, now)
        .map_err(HistoryStoreError::from)?;
    let reply = HistoryAnswer {
        tier: read.tier,
        bucket_ms: read.bucket_ms,
        complete_to_ms,
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
    bounded_reply(reply, q.max_points, |budget, reply| {
        let (mut read, _) = snapshot
            .merge(budget, now)
            .map_err(HistoryStoreError::from)?;
        reply.bucket_ms = read.bucket_ms;
        reply.stats = per_key_stats(&mut read, &q, &catalog, now);
        reply.series = wire_series(&read, &hold);
        Ok(())
    })
}

fn bounded_query(
    query: &HistoryQuery,
    catalog: &Catalog,
    host: HostId,
    now: i64,
) -> Result<(StoreQuery, Vec<HistoryClamp>, usize)> {
    let requested_to = query.to_ms.unwrap_or(now);
    if !is_js_safe(query.from_ms) || !is_js_safe(requested_to) {
        return Err(HistoryQueryError::Invalid(
            "History timestamps are out of range".into(),
        ));
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
            return Err(HistoryQueryError::Invalid("Unknown history metric".into()));
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
            unreachable!("the size check always encodes a history reply");
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
    use statglass_schema::{SeriesSelector, Tier};
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
    fn history_watermark_counts_closed_matching_source_buckets_only() {
        let now = 1_791_158_400_000 + 500;
        let start = now - 50_500;
        let host = host_record();
        let dir = tempfile::tempdir().unwrap();
        let store = HistoryStore::open(dir.path());
        let writer = store.register_host(&host).unwrap();
        let cpu = SeriesKey::parse("cpu.total").unwrap();
        let net = SeriesKey::parse("net.rx_total").unwrap();
        let row = |key, bucket_ts| BucketRow {
            host: host.id,
            tier: Tier::S10,
            bucket_ts,
            series: Arc::from([key]),
            stats: vec![10.0, 30.0, 20.0],
        };
        let q = HistoryQuery {
            series: vec![SeriesSelector {
                metric: cpu.metric.clone(),
                labels: cpu.labels.clone(),
            }],
            from_ms: start,
            to_ms: None,
            max_points: 1,
            events_for: None,
        };
        let run = |rows: Vec<BucketRow>| {
            let answer = read_history(
                &store,
                host.id,
                &q,
                now,
                |_, _| rows.clone(),
                |_, width| width,
            )
            .unwrap();
            let Answer::History(answer) = answer else {
                panic!("expected history")
            };
            answer
        };
        let current = now - 500;
        let open = row(cpu.clone(), current);
        let unrelated = row(net, current - 10_000);
        assert_eq!(
            run(vec![open.clone(), unrelated.clone()]).complete_to_ms,
            start
        );

        writer.write_bucket(row(cpu, start + 10_000)).unwrap();
        writer.flush().unwrap();
        assert_eq!(run(Vec::new()).complete_to_ms, start + 20_000);
        assert_eq!(run(vec![open, unrelated]).complete_to_ms, start + 20_000);
    }

    #[test]
    fn history_uses_one_bounded_recent_snapshot_to_close_the_commit_hole() {
        const BUCKET: i64 = 10_000;
        let current_bucket = 1_791_158_400_000;
        let now = current_bucket + 500;
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

        let from_ms = current_bucket - 3_600_000;
        let request = HistoryQuery {
            series: selectors,
            from_ms,
            to_ms: None,
            max_points: 500,
            events_for: None,
        };
        let calls = Cell::new(0);
        let answer = read_history(
            &store,
            host.id,
            &request,
            now,
            |from, to| {
                calls.set(calls.get() + 1);
                assert_eq!((from, to), (now - RECENT_ROWS_MS, now));
                vec![row(newest_closed), row(current_bucket)]
            },
            |_, width| width,
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
        assert_eq!(answer.series[0].points.last().unwrap().0, current_bucket);
    }
}
