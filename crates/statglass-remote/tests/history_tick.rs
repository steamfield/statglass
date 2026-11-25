//! Compare the same fake ticker with and without a pending history read on each tick.

#[path = "support/history_seed.rs"]
mod history_seed;

use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use statglass_engine::{
    ClockReading, Engine, EngineParts, FakeTicker, HistoryStore, LiveHub, NoPowerSignals,
    NoScaleStore, SourceSink,
};
use statglass_proto::{
    Answer, ErrorCode, Hello, HistoryAnswer, HistoryQuery, LiveTier, Message, Offer, Query,
    RemoteInterest, SyncRequest, WireHistorySeries,
};
use statglass_remote::{
    HostServer, ServedHost, ServerProvider,
    history_query::limits::{HISTORY_MAX_CONCURRENT, HistoryLimits},
    serve_connection,
};
use statglass_schema::{
    Capabilities, HostId, HostRecord, SeriesKey, SeriesSelector, Settings, SyncKinds, Tier,
    floor_to,
};
use statglass_session::codec;
use statglass_store::{BucketRow, HistoryQuery as StoreQuery, TierChoice};
use tokio::{
    io::DuplexStream,
    sync::{mpsc, oneshot},
    time::timeout,
};

const DAY_MS: i64 = 86_400_000;
const SERIES: usize = 32;
const TICKS: u32 = 16;
const DEADLINE: Duration = Duration::from_secs(5);
// Allow scheduler jitter around the same single-collector pump on a loaded test host.
const PUMP_TOLERANCE: Duration = Duration::from_millis(25);

type Read = oneshot::Sender<()>;
type SessionTask = tokio::task::JoinHandle<statglass_remote::Result<()>>;

struct Host {
    record: HostRecord,
    hub: LiveHub,
}

impl ServedHost for Host {
    fn record(&self) -> HostRecord {
        self.record.clone()
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }
    fn hub(&self) -> &LiveHub {
        &self.hub
    }
    fn set_remote_interest(&self, _: u64, _: RemoteInterest) {}
}

struct Session {
    server: HostServer<Host>,
    host: Arc<Host>,
    history: Arc<HistoryStore>,
    scaffold: bool,
    started: mpsc::UnboundedSender<Read>,
}

impl ServerProvider for Session {
    fn hello(&self) -> Hello {
        self.server.hello()
    }
    fn live(&self) -> LiveHub {
        self.server.live()
    }
    fn set_interest(&self, session: u64, interest: RemoteInterest) {
        self.server.set_interest(session, interest);
    }
    fn sync(&self, request: &SyncRequest, kinds: SyncKinds) -> Result<Message, String> {
        self.server.sync(request, kinds)
    }
    fn end_session(&self, session: u64) {
        self.server.end_session(session);
    }

    fn history_limits(&self) -> Option<&HistoryLimits> {
        self.server.history_limits()
    }

    fn answer(&self, session: u64, query: Query) -> Answer {
        let Query::History(history) = &query else {
            return self.server.answer(session, query);
        };
        if self.scaffold {
            // Hold the query inside the SQLite reader, after it has scanned durable
            // rows and before it merges the recent snapshot and finishes.
            return self.read_scaffold(history, || {
                if let Some(released) = self.observe_read() {
                    let _ = released.blocking_recv();
                }
                Vec::new()
            });
        }
        let released = self.observe_read();
        let answer = self.server.answer(session, query);
        // Run the real query concurrently with the tick, keeping its reply pending
        // even if the read finished before the session delivered the frame.
        if let Some(released) = released {
            let _ = released.blocking_recv();
        }
        answer
    }
}

impl Session {
    fn observe_read(&self) -> Option<oneshot::Receiver<()>> {
        let (release, released) = oneshot::channel();
        self.started.send(release).ok().map(|()| released)
    }

    fn read_scaffold(&self, query: &HistoryQuery, recent: impl Fn() -> Vec<BucketRow>) -> Answer {
        let to_ms = query.to_ms.expect("fixed end for the tick test");
        let result = self
            .history
            .history_through_now(
                &statglass_store::HistoryQuery {
                    host: self.host.record.id,
                    selectors: query.series.clone(),
                    from_ms: query.from_ms,
                    to_ms,
                    tier: TierChoice::Fixed(Tier::M15),
                    max_points: query.max_points,
                },
                recent,
            )
            .expect("read retained history");
        Answer::History(HistoryAnswer {
            tier: result.tier,
            bucket_ms: result.bucket_ms,
            complete_to_ms: to_ms,
            series: result
                .series
                .into_iter()
                .map(|series| WireHistorySeries {
                    key: series.key,
                    points: series
                        .points
                        .into_iter()
                        .map(|p| (p.t, p.avg, p.min, p.max))
                        .collect(),
                    hold_ms: result.bucket_ms,
                })
                .collect(),
            gaps: result.gaps,
            events: Vec::new(),
            stats: Vec::new(),
            clamped: Vec::new(),
        })
    }
}

fn fixture(dir: &Path, series: &[SeriesKey], now_ms: i64) -> (Arc<HistoryStore>, HostRecord, bool) {
    let history = history_seed::seed_by_retention(dir, series, now_ms);
    if let Some(host) = history
        .read(|r| r.hosts())
        .expect("read seeded hosts")
        .pop()
    {
        return (history, host, false);
    }

    // The scaffold seed opens an empty store. Give it real rows until lane j1 lands.
    let host = statglass_engine::host_record(HostId(uuid::Uuid::nil()));
    let writer = history
        .register_host(&host)
        .expect("register scaffold host");
    let series: Arc<[SeriesKey]> = series.into();
    for (tier, from, to) in [
        (Tier::M15, now_ms - 30 * DAY_MS, now_ms - DAY_MS),
        (Tier::M1, now_ms - DAY_MS, now_ms),
    ] {
        let step = tier.bucket_ms().expect("persisted tier") as usize;
        for bucket_ts in (from..to).step_by(step) {
            writer
                .write_bucket(BucketRow {
                    host: host.id,
                    tier,
                    bucket_ts,
                    series: series.clone(),
                    stats: vec![1.0; series.len() * 3],
                })
                .expect("seed a retained history bucket");
        }
    }
    writer.flush().expect("commit scaffold seed");
    (history, host, true)
}

async fn receive(client: &mut DuplexStream) -> Message {
    timeout(DEADLINE, codec::read(client))
        .await
        .expect("session must make progress")
        .expect("read a server message")
}

async fn handshake(client: &mut DuplexStream) {
    let Message::Hello(hello) = receive(client).await else {
        panic!("expected Hello");
    };
    let ack = statglass_proto::negotiate(
        &Offer::local(statglass_proto::local_features()),
        &Offer::from(&*hello),
    )
    .expect("negotiate history")
    .ack();
    codec::write(client, &Message::HelloAck(ack))
        .await
        .expect("acknowledge Hello");
    assert!(matches!(receive(client).await, Message::SourceStatus(_)));
}

async fn subscribe(client: &mut DuplexStream) {
    codec::write(
        client,
        &Message::Subscribe {
            tiers: vec![LiveTier::Live1s],
        },
    )
    .await
    .expect("subscribe to ticks");
    codec::write(client, &Message::Ping { nonce: 1, t0_ms: 0 })
        .await
        .expect("flush subscription");
    assert!(matches!(
        receive(client).await,
        Message::Pong { nonce: 1, .. }
    ));
}

async fn tick_frame(client: &mut DuplexStream) -> i64 {
    loop {
        match receive(client).await {
            Message::Live(frame) => return frame.ts_ms,
            Message::LayoutDef(_) | Message::SourceStatus(_) => {}
            other => panic!("expected a live frame before history could finish, got {other:?}"),
        }
    }
}

async fn connect(session: Arc<Session>) -> (DuplexStream, SessionTask) {
    let (mut client, peer) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(serve_connection(peer, session));
    handshake(&mut client).await;
    (client, task)
}

async fn reply(client: &mut DuplexStream, expected: u32) -> Answer {
    loop {
        match receive(client).await {
            Message::Reply { id, answer } => {
                assert_eq!(id, expected);
                return answer;
            }
            Message::HostSummary(_) | Message::SourceStatus(_) => {}
            other => panic!("unexpected message from history session: {other:?}"),
        }
    }
}

async fn history_pair(
    client: &mut DuplexStream,
    now_ms: i64,
    selectors: &[SeriesSelector],
    session: u32,
) {
    for id in 1..=2 {
        let query = Query::History(HistoryQuery {
            series: selectors.to_vec(),
            from_ms: now_ms - 30 * DAY_MS,
            to_ms: Some(now_ms),
            max_points: 200 + 2 * session + id,
            events_for: None,
        });
        codec::write(client, &Message::Request { id, query })
            .await
            .expect("queue history");
    }
}

async fn started(reads: &mut mpsc::UnboundedReceiver<Read>) -> Read {
    timeout(DEADLINE, reads.recv())
        .await
        .expect("history read must start")
        .expect("read started")
}

struct HistoryLoad {
    clients: Vec<(DuplexStream, SessionTask)>,
    reads: mpsc::UnboundedReceiver<Read>,
    held: Vec<Read>,
}

impl HistoryLoad {
    async fn start(
        session: Arc<Session>,
        mut reads: mpsc::UnboundedReceiver<Read>,
        now_ms: i64,
        selectors: &[SeriesSelector],
    ) -> Self {
        let mut clients = Vec::new();
        let mut held = Vec::new();
        for lane in 0..HISTORY_MAX_CONCURRENT {
            let (mut client, task) = connect(session.clone()).await;
            history_pair(&mut client, now_ms, selectors, lane as u32).await;
            held.push(started(&mut reads).await);
            clients.push((client, task));
        }

        let (mut excess, task) = connect(session).await;
        history_pair(
            &mut excess,
            now_ms,
            selectors,
            HISTORY_MAX_CONCURRENT as u32,
        )
        .await;
        for id in 1..=2 {
            tokio::select! {
                answer = reply(&mut excess, id) => {
                    assert!(matches!(answer, Answer::Error { code: ErrorCode::Busy, .. }));
                }
                read = reads.recv() => panic!("saturated host started an excess read: {}", read.is_some()),
            }
        }
        drop(excess);
        assert!(task.await.expect("join excess session").is_err());
        Self {
            clients,
            reads,
            held,
        }
    }

    async fn finish(mut self) {
        for release in self.held {
            release.send(()).expect("finish the first history read");
        }
        for (client, _) in &mut self.clients {
            assert_history(reply(client, 1).await);
        }
        for _ in 0..HISTORY_MAX_CONCURRENT {
            started(&mut self.reads)
                .await
                .send(())
                .expect("finish the queued history read");
        }
        for (mut client, task) in self.clients {
            assert_history(reply(&mut client, 2).await);
            drop(client);
            assert!(task.await.expect("join history session").is_err());
        }
    }
}

fn assert_history(answer: Answer) {
    let Answer::History(answer) = answer else {
        panic!("expected history, got {answer:?}");
    };
    assert_eq!(answer.series.len(), SERIES);
    assert!(answer.series.iter().all(|series| !series.points.is_empty()));
}

fn memory_points(history: &HistoryStore, host: HostId, from_ms: i64, to_ms: i64) -> usize {
    history
        .read(|reader| {
            reader.history(&StoreQuery {
                host,
                selectors: vec![SeriesSelector {
                    metric: statglass_schema::MetricId::parse("mem.used").expect("valid metric"),
                    labels: Default::default(),
                }],
                from_ms,
                to_ms,
                tier: TierChoice::Fixed(Tier::S10),
                max_points: TICKS,
            })
        })
        .expect("read the writer's S10 buckets")
        .series
        .iter()
        .map(|series| series.points.len())
        .sum()
}

async fn run_ticks(
    dir: &Path,
    now_ms: i64,
    series: &[SeriesKey],
    with_history: bool,
) -> (Vec<i64>, Duration) {
    let (history, record, scaffold) = fixture(dir, series, now_ms);
    let host = Arc::new(Host {
        record,
        hub: LiveHub::default(),
    });
    let (ticker, clock) = FakeTicker::at(ClockReading {
        wall_ms: now_ms,
        ..Default::default()
    });
    let mut parts = EngineParts::platform(Arc::new(NoScaleStore));
    parts
        .collectors
        .retain(|collector| collector.id().0 == "memory");
    parts.ticker = Box::new(ticker);
    parts.power = Box::new(NoPowerSignals);
    parts.hints = None;
    let writer = history.writer().expect("open history writer");
    let mut engine = Engine::new(
        host.record.id,
        parts,
        SourceSink {
            live: host.hub.clone(),
            store: Some(writer.clone()),
        },
        &Settings::default(),
    );
    engine.start();
    drop(engine.control().set_detail_interest(true));
    assert!(engine.pump());
    let period_ms = clock.period().expect("ticker started").as_millis() as i64;

    let (started, reads) = mpsc::unbounded_channel();
    let session = Arc::new(Session {
        server: HostServer::new(host.clone(), history.clone()),
        host: host.clone(),
        history: history.clone(),
        scaffold,
        started,
    });
    let (mut client, server) = connect(session.clone()).await;
    subscribe(&mut client).await;
    let load = if with_history {
        let selectors: Vec<_> = series
            .iter()
            .map(|key| SeriesSelector {
                metric: key.metric.clone(),
                labels: key.labels.clone(),
            })
            .collect();
        Some(HistoryLoad::start(session, reads, now_ms, &selectors).await)
    } else {
        None
    };
    let (mut delivered, before_flush) = sample_ticks(
        &mut engine,
        &clock,
        &mut client,
        now_ms,
        period_ms,
        1..=TICKS - 2,
    )
    .await;

    assert_eq!(
        memory_points(&history, host.record.id, now_ms, now_ms + 10_000),
        0,
        "the completed S10 bucket is still in the writer's batch"
    );
    tokio::task::spawn_blocking(move || writer.flush())
        .await
        .expect("join writer flush")
        .expect("flush while reads are pending");
    assert_eq!(
        memory_points(&history, host.record.id, now_ms, now_ms + 10_000),
        1
    );
    let (after_ticks, after_flush) = sample_ticks(
        &mut engine,
        &clock,
        &mut client,
        now_ms,
        period_ms,
        TICKS - 1..=TICKS,
    )
    .await;
    delivered.extend(after_ticks);
    if let Some(load) = load {
        load.finish().await;
    }
    drop(client);
    assert!(server.await.expect("join live session").is_err());
    (delivered, before_flush.max(after_flush))
}

async fn sample_ticks(
    engine: &mut Engine,
    clock: &statglass_engine::FakeClock,
    client: &mut DuplexStream,
    now_ms: i64,
    period_ms: i64,
    ticks: std::ops::RangeInclusive<u32>,
) -> (Vec<i64>, Duration) {
    let mut delivered = Vec::new();
    let mut max_pump = Duration::ZERO;
    for tick in ticks {
        assert!(clock.tick());
        let started = Instant::now();
        assert!(engine.pump());
        max_pump = max_pump.max(started.elapsed());
        let delivered_ms = tick_frame(client).await;
        assert_eq!(delivered_ms, now_ms + period_ms * i64::from(tick));
        delivered.push(delivered_ms);
    }
    (delivered, max_pump)
}

#[tokio::test]
async fn every_sample_reaches_the_same_deadline_with_back_to_back_history_queries() {
    let baseline = tempfile::tempdir().expect("no-query fixture");
    let loaded = tempfile::tempdir().expect("history fixture");
    let now_ms = floor_to(statglass_engine::wall_ms(), 900_000);
    let series: Vec<_> = (0..SERIES)
        .map(|i| SeriesKey::parse(&format!("net.rx{{iface=eth{i}}}")).expect("valid fixture key"))
        .collect();
    let (baseline_ticks, baseline_pump) = run_ticks(baseline.path(), now_ms, &series, false).await;
    let (loaded_ticks, loaded_pump) = run_ticks(loaded.path(), now_ms, &series, true).await;
    assert_eq!(loaded_ticks, baseline_ticks);
    println!(
        "max engine.pump latency {loaded_pump:?} with pending reads, baseline {baseline_pump:?}, tolerance {PUMP_TOLERANCE:?}"
    );
    assert!(
        loaded_pump <= baseline_pump + PUMP_TOLERANCE,
        "max engine.pump latency {loaded_pump:?} with pending reads, baseline {baseline_pump:?}, tolerance {PUMP_TOLERANCE:?}"
    );
}
