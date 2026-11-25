use std::{sync::Arc, time::Duration};

use statglass_engine::{HistoryStore, LiveHub};
use statglass_proto::{
    Answer, ErrorCode, Hello, HistoryQuery, Message, Offer, Query, RemoteInterest, SyncRequest,
};
use statglass_remote::{
    HostServer, ServedHost, ServerProvider, history_query::limits::HistoryLimits, serve_connection,
};
use statglass_schema::{Capabilities, HostId, HostRecord, MetricId, SeriesSelector, SyncKinds};
use statglass_session::codec;
use tokio::{
    io::DuplexStream,
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;

type SessionTask = JoinHandle<statglass_remote::Result<()>>;
const DEADLINE: Duration = Duration::from_secs(5);

struct Read {
    from_ms: i64,
    finish: oneshot::Sender<()>,
}

struct Host {
    reads: mpsc::UnboundedSender<Read>,
    server: Arc<HostServer<TestHost>>,
}

struct TestHost {
    record: HostRecord,
    live: LiveHub,
}

impl ServedHost for TestHost {
    fn record(&self) -> HostRecord {
        self.record.clone()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn hub(&self) -> &LiveHub {
        &self.live
    }

    fn set_remote_interest(&self, _: u64, _: RemoteInterest) {}
}

impl ServerProvider for Host {
    fn hello(&self) -> Hello {
        self.server.hello()
    }

    fn live(&self) -> LiveHub {
        self.server.live()
    }

    fn set_interest(&self, _: u64, _: RemoteInterest) {}

    fn sync(&self, _: &SyncRequest, _: SyncKinds) -> Result<Message, String> {
        Err("no sync in this fixture".into())
    }

    fn answer(&self, _: u64, query: Query) -> Answer {
        if let Query::History(query) = query {
            let (finish, finished) = oneshot::channel();
            if self
                .reads
                .send(Read {
                    from_ms: query.from_ms,
                    finish,
                })
                .is_ok()
            {
                let _ = finished.blocking_recv();
            }
        }
        Answer::Done
    }

    fn end_session(&self, _: u64) {}

    fn history_limits(&self) -> Option<&HistoryLimits> {
        self.server.history_limits()
    }
}

fn host() -> (Arc<Host>, mpsc::UnboundedReceiver<Read>) {
    let (reads, observed) = mpsc::unbounded_channel();
    let host = Arc::new(TestHost {
        record: statglass_engine::host_record(HostId(Uuid::nil())),
        live: LiveHub::default(),
    });
    let server = Arc::new(HostServer::new(host, Arc::new(HistoryStore::unavailable())));
    (Arc::new(Host { reads, server }), observed)
}

async fn session(host: Arc<dyn ServerProvider>) -> (DuplexStream, SessionTask) {
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    let server = tokio::spawn(serve_connection(server, host));
    let Message::Hello(hello) = receive(&mut client).await else {
        panic!("expected Hello");
    };
    let ack = statglass_proto::negotiate(
        &Offer::local(statglass_proto::local_features()),
        &Offer::from(&*hello),
    )
    .expect("negotiate history")
    .ack();
    codec::write(&mut client, &Message::HelloAck(ack))
        .await
        .expect("acknowledge Hello");
    assert!(matches!(
        receive(&mut client).await,
        Message::SourceStatus(_)
    ));
    (client, server)
}

async fn receive(client: &mut DuplexStream) -> Message {
    timeout(DEADLINE, codec::read(client))
        .await
        .expect("session must make progress")
        .expect("read a message")
}

async fn request(client: &mut DuplexStream, id: u32, query: Query) {
    codec::write(client, &Message::Request { id, query })
        .await
        .expect("write request");
}

fn history(from_ms: i64, max_points: u32, metrics: &[&str]) -> Query {
    Query::History(HistoryQuery {
        series: metrics
            .iter()
            .map(|metric| SeriesSelector {
                metric: MetricId::parse(metric).expect("valid metric"),
                labels: Default::default(),
            })
            .collect(),
        from_ms,
        to_ms: Some(100_000),
        max_points,
        events_for: None,
    })
}

async fn started(reads: &mut mpsc::UnboundedReceiver<Read>, expected: u32) -> oneshot::Sender<()> {
    let read = timeout(DEADLINE, reads.recv())
        .await
        .expect("the next history read must start")
        .expect("read observer is connected");
    assert_eq!(
        read.from_ms,
        i64::from(expected),
        "history ran out of arrival order"
    );
    read.finish
}

async fn expect_busy(client: &mut DuplexStream, expected: u32) {
    assert!(
        matches!(receive(client).await, Message::Reply {
            id, answer: Answer::Error { code: ErrorCode::Busy, .. },
        } if id == expected),
        "request {expected} must receive Busy"
    );
}

async fn expect_done(client: &mut DuplexStream, expected: u32) {
    assert_eq!(
        receive(client).await,
        Message::Reply {
            id: expected,
            answer: Answer::Done
        }
    );
}

#[tokio::test]
async fn history_ranges_replace_only_waiting_queries_for_the_same_chart() {
    let (host, mut reads) = host();
    let (mut client, server) = session(host).await;
    let cpu = ["cpu.total", "cpu.user"];
    request(&mut client, 1, history(1, 200, &cpu)).await;
    let first = started(&mut reads, 1).await;
    request(&mut client, 2, history(2, 200, &cpu)).await;
    request(&mut client, 3, history(3, 200, &["mem.used"])).await;
    request(&mut client, 4, history(4, 60, &cpu)).await;
    request(
        &mut client,
        5,
        history(5, 200, &["cpu.user", "cpu.total", "cpu.total"]),
    )
    .await;
    expect_busy(&mut client, 2).await;

    request(&mut client, 6, Query::SpaceStatus).await;
    expect_done(&mut client, 6).await;
    assert!(
        reads.try_recv().is_err(),
        "only the first history read may run"
    );

    first.send(()).expect("finish active history");
    expect_done(&mut client, 1).await;
    for id in [3, 4, 5] {
        started(&mut reads, id)
            .await
            .send(())
            .expect("finish queued history");
        expect_done(&mut client, id).await;
    }
    drop(client);
    assert!(server.await.expect("join session").is_err());
}

#[tokio::test]
async fn history_queue_rejects_a_ninth_waiter_and_still_accepts_replacements() {
    let (host, mut reads) = host();
    let (mut client, server) = session(host).await;
    let cpu = ["cpu.total"];
    request(&mut client, 1, history(1, 1, &cpu)).await;
    let first = started(&mut reads, 1).await;
    for id in 2..=10 {
        request(&mut client, id, history(i64::from(id), id, &cpu)).await;
    }
    expect_busy(&mut client, 10).await;
    request(&mut client, 11, history(11, 2, &cpu)).await;
    expect_busy(&mut client, 2).await;

    request(&mut client, 12, Query::SpaceStatus).await;
    expect_done(&mut client, 12).await;
    first.send(()).expect("finish active history");
    expect_done(&mut client, 1).await;
    for id in (3..=9).chain([11]) {
        started(&mut reads, id)
            .await
            .send(())
            .expect("finish queued history");
        expect_done(&mut client, id).await;
    }
    drop(client);
    assert!(server.await.expect("join session").is_err());
}

#[test]
fn history_host_limit_rejects_before_blocking_dispatch_and_is_independent_per_server() {
    tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(3)
        .enable_all()
        .build()
        .expect("start test runtime")
        .block_on(async {
            let (host_a, mut reads_a) = host();
            let (host_b, mut reads_b) = host();
            let (mut first, first_task) = session(host_a.clone()).await;
            let (mut second, second_task) = session(host_a.clone()).await;
            let (mut excess, excess_task) = session(host_a.server.clone()).await;
            let (mut independent, independent_task) = session(host_b).await;
            let cpu = ["cpu.total"];

            request(&mut first, 1, history(1, 200, &cpu)).await;
            let finish_first = started(&mut reads_a, 1).await;
            request(&mut second, 2, history(2, 200, &cpu)).await;
            let finish_second = started(&mut reads_a, 2).await;
            request(&mut independent, 3, history(3, 200, &cpu)).await;
            let finish_independent = started(&mut reads_b, 3).await;

            // Both host A slots and all blocking workers are occupied. A real HostServer
            // still sends Busy through the wire while host B's independent job runs.
            request(&mut excess, 4, history(4, 200, &cpu)).await;
            expect_busy(&mut excess, 4).await;

            finish_first.send(()).expect("release first read");
            expect_done(&mut first, 1).await;
            request(&mut first, 5, history(5, 200, &cpu)).await;
            started(&mut reads_a, 5)
                .await
                .send(())
                .expect("reuse released permit");
            expect_done(&mut first, 5).await;

            finish_second.send(()).expect("release second read");
            finish_independent
                .send(())
                .expect("release independent read");
            expect_done(&mut second, 2).await;
            expect_done(&mut independent, 3).await;
            drop((first, second, excess, independent));
            for task in [first_task, second_task, excess_task, independent_task] {
                assert!(task.await.expect("join session").is_err());
            }
        });
}
