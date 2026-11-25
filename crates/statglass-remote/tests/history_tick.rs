//! Compare the same fake ticker with and without a pending history read on each tick.

#[path = "support/history_seed.rs"]
mod history_seed;

use std::{path::Path, sync::Arc, time::Duration};

use statglass_engine::{
    ClockReading, Engine, EngineParts, FakeTicker, HistoryStore, LiveHub, NoPowerSignals,
    SourceSink,
};
use statglass_proto::{
    Answer, Hello, HistoryAnswer, HistoryQuery, LiveTier, Message, Offer, Query, RemoteInterest,
    SyncRequest, WireHistorySeries,
};
use statglass_remote::{
    HostServer, ServedHost, ServerProvider, history_query::limits::HistoryLimits, serve_connection,
};
use statglass_schema::{
    Capabilities, HostId, HostRecord, SeriesKey, SeriesSelector, Settings, SyncKinds, Tier,
    floor_to,
};
use statglass_session::codec;
use statglass_store::{BucketRow, TierChoice};
use tokio::{
    io::DuplexStream,
    sync::{mpsc, oneshot},
    time::timeout,
};

const DAY_MS: i64 = 86_400_000;
const SERIES: usize = 32;
const TICKS: u32 = 8;
const DEADLINE: Duration = Duration::from_secs(5);

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
    started: mpsc::UnboundedSender<oneshot::Sender<()>>,
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

async fn subscribe(client: &mut DuplexStream) {
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

async fn run_ticks(dir: &Path, now_ms: i64, series: &[SeriesKey], with_history: bool) -> Vec<i64> {
    let (history, record, scaffold) = fixture(dir, series, now_ms);
    let host = Arc::new(Host {
        record,
        hub: LiveHub::default(),
    });
    let (ticker, clock) = FakeTicker::at(ClockReading {
        wall_ms: now_ms,
        ..Default::default()
    });
    let mut engine = Engine::new(
        host.record.id,
        EngineParts {
            collectors: Vec::new(),
            ticker: Box::new(ticker),
            power: Box::new(NoPowerSignals),
            hints: None,
        },
        SourceSink {
            live: host.hub.clone(),
            store: Some(history.writer().expect("open history writer")),
        },
        &Settings::default(),
    );
    engine.start();
    let period_ms = clock.period().expect("ticker started").as_millis() as i64;
    let (started, mut reads) = mpsc::unbounded_channel();
    let session = Arc::new(Session {
        server: HostServer::new(host.clone(), history.clone()),
        host,
        history,
        scaffold,
        started,
    });
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    let server = tokio::spawn(serve_connection(server, session));
    subscribe(&mut client).await;

    let selectors: Vec<_> = series
        .iter()
        .map(|key| SeriesSelector {
            metric: key.metric.clone(),
            labels: key.labels.clone(),
        })
        .collect();
    let mut delivered = Vec::new();
    for id in 1..=TICKS {
        let release = if with_history {
            let query = Query::History(HistoryQuery {
                series: selectors.clone(),
                from_ms: now_ms - 30 * DAY_MS,
                to_ms: Some(now_ms),
                max_points: 200 + id,
                events_for: None,
            });
            codec::write(&mut client, &Message::Request { id, query })
                .await
                .expect("request history");
            Some(
                timeout(DEADLINE, reads.recv())
                    .await
                    .expect("history read must start")
                    .expect("read started"),
            )
        } else {
            None
        };
        let started = std::time::Instant::now();
        assert!(clock.tick());
        assert!(engine.pump());
        let delivered_ms = tick_frame(&mut client).await;
        assert!(
            started.elapsed() < Duration::from_millis(period_ms as u64),
            "the frame missed the next sampler deadline"
        );
        assert_eq!(delivered_ms, now_ms + period_ms * i64::from(id));
        delivered.push(delivered_ms);

        if let Some(release) = release {
            release.send(()).expect("release history read");
            let Message::Reply {
                id: actual,
                answer: Answer::History(answer),
            } = receive(&mut client).await
            else {
                panic!("expected a history answer");
            };
            assert_eq!(actual, id);
            assert_eq!(answer.series.len(), SERIES);
            assert!(answer.series.iter().all(|series| !series.points.is_empty()));
        }
    }
    drop(client);
    assert!(server.await.expect("join server").is_err());
    delivered
}

#[tokio::test]
async fn every_sample_reaches_the_same_deadline_with_back_to_back_history_queries() {
    let baseline = tempfile::tempdir().expect("no-query fixture");
    let loaded = tempfile::tempdir().expect("history fixture");
    let now_ms = floor_to(statglass_engine::wall_ms(), 900_000);
    let series: Vec<_> = (0..SERIES)
        .map(|i| SeriesKey::parse(&format!("net.rx{{iface=eth{i}}}")).expect("valid fixture key"))
        .collect();
    assert_eq!(
        run_ticks(loaded.path(), now_ms, &series, true).await,
        run_ticks(baseline.path(), now_ms, &series, false).await,
    );
}
