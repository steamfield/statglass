use std::{
    borrow::Cow,
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use statglass_engine::HistoryStore;
use statglass_proto::{Answer, ErrorCode, HistoryAnswer, HistoryQuery};
use statglass_schema::{TimeRange, is_js_safe, lock::LockExt};
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
    generation: u64,
    query: HistoryQuery,
    end_ms: i64,
    answer: Arc<HistoryAnswer>,
    expires: Instant,
}

impl CacheEntry {
    fn matches(&self, query: &HistoryQuery, end_ms: i64) -> bool {
        let width = self.answer.bucket_ms;
        // Preserve selector order because the read may clamp the list.
        let last_bucket = |end: i64| end.saturating_sub(1).div_euclid(width);
        self.query.max_points == query.max_points
            && self.query.events_for == query.events_for
            && self.query.from_ms.div_euclid(width) == query.from_ms.div_euclid(width)
            && last_bucket(self.end_ms) == last_bucket(end_ms)
            // Events, gaps and the read's watermark still depend on the exact bounds.
            && self.query.from_ms == query.from_ms
            && self.end_ms == end_ms
            && self.query.series == query.series
    }
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
        read: impl FnOnce(&HistoryQuery) -> Answer,
    ) -> Answer {
        self.answer_at(store, query, statglass_engine::wall_ms(), read)
    }

    fn answer_at(
        &self,
        store: &HistoryStore,
        query: &HistoryQuery,
        now_ms: i64,
        read: impl FnOnce(&HistoryQuery) -> Answer,
    ) -> Answer {
        let requested_end = query.to_ms.unwrap_or(now_ms);
        let end_ms = requested_end.min(now_ms);
        if !is_js_safe(query.from_ms)
            || !is_js_safe(requested_end)
            || TimeRange::new(query.from_ms, end_ms, i64::MAX).is_err()
        {
            return read(query);
        }
        let generation = store.generation();
        if let Some(answer) = self.cached(generation, query, end_ms) {
            return Answer::History((*answer).clone());
        }
        // Use the same resolved end for the reader and the cache, including rolling queries.
        let effective = if query.to_ms == Some(end_ms) {
            Cow::Borrowed(query)
        } else {
            Cow::Owned(HistoryQuery {
                to_ms: Some(end_ms),
                ..query.clone()
            })
        };
        let answer = read(&effective);
        if let Answer::History(history) = &answer
            && history.bucket_ms > 0
            && store.generation() == generation
        {
            let entry = CacheEntry {
                generation,
                query: effective.into_owned(),
                end_ms,
                answer: Arc::new(history.clone()),
                expires: Instant::now() + HISTORY_CACHE_TTL,
            };
            let mut cache = self.cache.lock_ok();
            cache.retain(|older| older.generation == generation && !older.matches(query, end_ms));
            if cache.len() == HISTORY_CACHE_ENTRIES {
                cache.pop_back();
            }
            cache.push_front(entry);
        }
        answer
    }

    fn cached(
        &self,
        generation: u64,
        query: &HistoryQuery,
        end_ms: i64,
    ) -> Option<Arc<HistoryAnswer>> {
        let mut cache = self.cache.lock_ok();
        let now = Instant::now();
        cache.retain(|entry| entry.generation == generation && now < entry.expires);
        cache
            .iter()
            .find(|entry| entry.matches(query, end_ms))
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

    #[tokio::test(start_paused = true)]
    async fn identical_and_equivalent_history_reuse_a_read_until_expiry() {
        let dir = tempfile::tempdir().expect("test history directory");
        let store = HistoryStore::open(dir.path());
        let host = crate::test_support::bare_host(1, "Test host", OsKind::Linux);
        let writer = store.register_host(&host).expect("register test host");
        writer
            .write_bucket(BucketRow {
                host: host.id,
                tier: Tier::M1,
                bucket_ts: 60_000,
                series: vec![
                    statglass_schema::SeriesKey::parse("cpu.total").expect("valid series"),
                ]
                .into(),
                stats: vec![1.0; 3],
            })
            .expect("write test history");
        writer.flush().expect("commit test history");
        let first = HistoryLimits::default();
        let second = HistoryLimits::default();
        let reads = Cell::new(0);
        let read = |q: &HistoryQuery| {
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
            let points = result
                .series
                .iter()
                .map(|series| series.points.len() as i64)
                .sum::<i64>();
            assert_eq!(points, 1);
            reads.set(reads.get() + points);
            Answer::History(page(reads.get()))
        };
        let original = query(200);
        let same_effective_end = HistoryQuery {
            to_ms: Some(120_003),
            ..original.clone()
        };
        let ask = |limits: &HistoryLimits, q| limits.answer_at(&store, q, 120_002, read);
        assert_eq!(ask(&first, &original), Answer::History(page(1)));
        assert_eq!(ask(&first, &original), Answer::History(page(1)));
        assert_eq!(ask(&first, &same_effective_end), Answer::History(page(1)));
        assert_eq!(reads.get(), 1);
        assert_eq!(ask(&second, &original), Answer::History(page(2)));

        tokio::time::advance(HISTORY_CACHE_TTL - Duration::from_millis(1)).await;
        assert_eq!(ask(&first, &original), Answer::History(page(1)));
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(ask(&first, &original), Answer::History(page(3)));
        assert_eq!(reads.get(), 3);
    }

    #[test]
    fn history_cache_respects_budget_event_module_and_selectors() {
        let store = HistoryStore::unavailable();
        let limits = HistoryLimits::default();
        let baseline = query(200);
        let first = Answer::History(page(1));
        let second = Answer::History(page(2));
        assert_eq!(limits.answer(&store, &baseline, |_| first.clone()), first);
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
                limits.answer(&store, &different, |_| second.clone()),
                second
            );
        }
        assert_eq!(limits.answer(&store, &baseline, |_| second.clone()), first);
    }

    #[test]
    fn history_cache_cannot_hide_a_range_inverted_after_clamping_to_now() {
        let store = HistoryStore::unavailable();
        let limits = HistoryLimits::default();
        let valid = HistoryQuery {
            from_ms: 60_000,
            to_ms: Some(60_010),
            ..query(200)
        };
        let invalid = HistoryQuery {
            from_ms: 60_001,
            ..valid.clone()
        };
        let error = Answer::Error {
            code: ErrorCode::InvalidArgument,
            message: "History range must be positive".into(),
        };
        let valid_answer = Answer::History(page(60_001));
        assert_eq!(
            limits.answer_at(&store, &valid, 60_001, |q| {
                assert_eq!(q.to_ms, Some(60_001));
                valid_answer.clone()
            }),
            valid_answer,
        );
        assert_eq!(
            limits.answer_at(&store, &invalid, 60_001, |_| error.clone()),
            error
        );
        let outside_wire_range = HistoryQuery {
            to_ms: Some(i64::MAX),
            ..valid
        };
        assert_eq!(
            limits.answer_at(&store, &outside_wire_range, 60_001, |_| error.clone()),
            error
        );
    }

    fn read_gaps(
        store: &HistoryStore,
        host: HostId,
        limits: &HistoryLimits,
        q: &HistoryQuery,
    ) -> Answer {
        limits.answer(store, q, |q| {
            let end = q.to_ms.expect("effective end");
            let mut answer = page(end);
            answer.gaps = store
                .read(|r| r.gaps(host, q.from_ms, end))
                .expect("read history gaps");
            Answer::History(answer)
        })
    }

    #[test]
    fn history_cache_keeps_exact_bounds_within_an_output_bucket() {
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
            to_ms: Some(120_005),
            ..short.clone()
        };
        let mut full_page = page(120_005);
        full_page.gaps = vec![gap];
        assert_eq!(
            read_gaps(&store, host.id, &limits, &wide),
            Answer::History(full_page)
        );
        assert_eq!(
            read_gaps(&store, host.id, &limits, &short),
            Answer::History(page(120_002))
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
        drop(writer);

        let limits = HistoryLimits::default();
        let q = query(200);
        let mut before = page(120_002);
        before.gaps = vec![gap];
        assert_eq!(
            read_gaps(&store, host.id, &limits, &q),
            Answer::History(before)
        );
        drop(store.reset(120_002).expect("clear history"));
        store
            .register_host(&host)
            .expect("register host in replacement store")
            .flush()
            .expect("commit host");
        assert_eq!(
            read_gaps(&store, host.id, &limits, &q),
            Answer::History(page(120_002))
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
        let mut expected = page(120_002);
        expected.gaps = vec![gap];
        let expected = Answer::History(expected);
        // Supply the read through the scaffold seam. The wire requests enter the
        // real HostServer and reuse this page before reaching the stub reader.
        assert_eq!(
            read_gaps(&store, host_id, &server.history_limits, &q),
            expected
        );
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
        let store = HistoryStore::unavailable();
        let limits = HistoryLimits::default();
        let original = Answer::History(page(1));
        let fresh = Answer::History(page(2));
        assert_eq!(limits.answer(&store, &query(1), |_| busy()), busy());
        for budget in 1..=17 {
            assert_eq!(
                limits.answer(&store, &query(budget), |_| original.clone()),
                original
            );
        }
        let mut hits = 0;
        // A miss returns an uncached answer so probing cannot evict another entry.
        for budget in 1..=17 {
            if limits.answer(&store, &query(budget), |_| Answer::Unknown) == original {
                hits += 1;
            }
        }
        assert_eq!(hits, 16);
        assert_eq!(limits.answer(&store, &query(18), |_| fresh.clone()), fresh);
    }
}
