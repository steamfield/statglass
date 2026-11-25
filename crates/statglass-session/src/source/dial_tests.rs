use super::*;
use crate::test_support::{endpoint, fixture_hello};
use crate::{BoxFuture, Close, DialFailure, DialedStream, Target};
use tokio::{io::DuplexStream, sync::mpsc, time::timeout};

const WAIT: Duration = Duration::from_secs(5);
type Attempts = mpsc::UnboundedReceiver<(Target, Instant)>;
type SessionTask = tokio::task::JoinHandle<Result<Option<SshSession>>>;

struct FakeDialer {
    attempts: mpsc::UnboundedSender<(Target, Instant)>,
    accepted: Option<&'static str>,
}

impl Dialer for FakeDialer {
    fn dial<'a>(
        &'a self,
        _: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, Result<DialedStream>> {
        Box::pin(async move {
            self.attempts
                .send((target.clone(), Instant::now()))
                .unwrap();
            if self.accepted != Some(target.host.as_str()) {
                return Err(RemoteError::Timeout(format!(
                    "{} did not answer",
                    target.host
                )));
            }
            let (client, peer) = tokio::io::duplex(65536);
            let (reader, writer) = tokio::io::split(client);
            let task = tokio::spawn(serve(peer));
            Ok(DialedStream {
                reader: Box::pin(reader),
                writer: Box::pin(writer),
                stderr: Default::default(),
                close: Box::new(Peer {
                    _task: codec::AbortOnDrop(task),
                }),
            })
        })
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        // Return, don't panic: a panic here lands on the source's thread or the
        // promotion task, and the test would time out with no cause.
        RemoteError::Protocol(format!(
            "fake peer did not greet the client: {:?}",
            failure.outcome
        ))
    }
}

struct Peer {
    _task: codec::AbortOnDrop,
}

impl Close for Peer {
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async { drop(self) })
    }
}

async fn serve(mut peer: DuplexStream) {
    codec::write(&mut peer, &Message::Hello(Box::new(fixture_hello())))
        .await
        .unwrap();
    assert!(matches!(
        codec::read(&mut peer).await.unwrap(),
        Message::HelloAck(_)
    ));
    while let Ok(message) = codec::read(&mut peer).await {
        if let Message::Ping { nonce, t0_ms } = message
            && codec::write(
                &mut peer,
                &Message::Pong {
                    nonce,
                    t0_ms,
                    t_remote_ms: statglass_engine::wall_ms(),
                },
            )
            .await
            .is_err()
        {
            break;
        }
    }
}

fn source(
    routes: &[(Route, &str)],
    accepted: Option<&'static str>,
    status: StatusCallback,
) -> (Arc<RemoteSource>, Attempts) {
    let (attempts, rx) = mpsc::unbounded_channel();
    let source = RemoteSource::new(
        HostRecord::from_identity(fixture_hello().host, false),
        HostId(uuid::Uuid::nil()),
        Arc::new(FakeDialer { attempts, accepted }),
        endpoint(routes),
        status,
        None,
    );
    (source, rx)
}

fn sink() -> SourceSink {
    SourceSink {
        live: Default::default(),
        store: None,
    }
}

#[tokio::test]
async fn the_injected_dialer_receives_one_dial_per_attempt_and_sets_the_route() {
    let (status_tx, mut status_rx) = watch::channel(ConnectionStatus::default());
    let host = "studio.tailnet.ts.net";
    let (source, mut attempts) = source(
        &[(Route::Tailscale, host)],
        Some(host),
        Arc::new(move |status| {
            status_tx.send_replace(status);
        }),
    );
    let _handle = source.clone().start(sink()).unwrap();
    for attempt in 0..2 {
        let (target, _) = timeout(WAIT, attempts.recv()).await.unwrap().unwrap();
        assert_eq!(
            target,
            Target {
                route: Route::Tailscale,
                host: host.into()
            }
        );
        let connected = timeout(
            WAIT,
            status_rx.wait_for(|s| s.connected && source.clock().now_ms().is_some()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(connected.route, Some(Route::Tailscale));
        drop(connected);
        assert!(attempts.try_recv().is_err(), "extra dial");
        if attempt == 0 {
            source.retry();
        }
    }
}

const TAILNET: &[(Route, &str)] = &[
    (Route::Tailscale, "studio.tailnet.ts.net"),
    (Route::Tailscale, "100.64.0.1"),
];
const MIXED: &[(Route, &str)] = &[
    (Route::Lan, "studio.local"),
    (Route::Lan, "studio.lan"),
    TAILNET[0],
    TAILNET[1],
];

#[tokio::test]
async fn connection_status_reports_the_winning_route_when_the_first_target_fails() {
    let (status_tx, mut status_rx) = watch::channel(ConnectionStatus::default());
    let (source, mut attempts) = source(
        &[MIXED[0], TAILNET[0]],
        Some(TAILNET[0].1),
        Arc::new(move |status| {
            status_tx.send_replace(status);
        }),
    );
    let _handle = source.start(sink()).unwrap();
    let connected = timeout(WAIT, status_rx.wait_for(|s| s.connected))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(connected.route, Some(Route::Tailscale));
    let mut attempted: Vec<_> = std::iter::from_fn(|| attempts.try_recv().ok())
        .map(|(target, _)| target.route)
        .collect();
    attempted.sort_unstable();
    assert_eq!(attempted, [Route::Lan, Route::Tailscale]);
}

fn connected_source(
    routes: &[(Route, &str)],
    current: (Route, &str),
    accepted: Option<&'static str>,
) -> (Arc<RemoteSource>, Attempts, DuplexStream, SessionTask) {
    let (source, attempts) = source(routes, accepted, Arc::new(|_| {}));
    let (client, peer) = tokio::io::duplex(65536);
    let mut session = SshSession::test(client, fixture_hello());
    session.route = current.0;
    session.target = Target {
        route: current.0,
        host: current.1.into(),
    };
    let runner = source.clone();
    let task = tokio::spawn(async move {
        let mut control = runner.control.subscribe();
        let mut status = ConnectionStatus::default();
        session_loop(&runner, &sink(), session, &mut control, &mut status).await
    });
    (source, attempts, peer, task)
}

async fn network_change(source: &RemoteSource, peer: &mut DuplexStream) -> Instant {
    assert!(matches!(
        codec::read(peer).await.unwrap(),
        Message::Interest(_)
    ));
    let Message::Ping { nonce, t0_ms } = codec::read(peer).await.unwrap() else {
        panic!("expected initial Ping");
    };
    codec::write(
        peer,
        &Message::Pong {
            nonce,
            t0_ms,
            t_remote_ms: 1,
        },
    )
    .await
    .unwrap();
    let changed = Instant::now();
    source.network_changed();
    assert!(matches!(
        codec::read(peer).await.unwrap(),
        Message::Interest(_)
    ));
    changed
}

async fn expect_lan_dials(attempts: &mut Attempts, changed: Instant) {
    let mut hosts = Vec::new();
    for _ in 0..2 {
        let (target, at) = timeout(WAIT, attempts.recv()).await.unwrap().unwrap();
        assert_eq!(target.route, Route::Lan);
        assert_eq!(at - changed, PROMOTION_DEBOUNCE);
        hosts.push(target.host);
    }
    hosts.sort();
    assert_eq!(hosts, ["studio.lan", "studio.local"]);
    assert!(attempts.try_recv().is_err(), "extra promotion dial");
}

async fn next_heartbeat(peer: &mut DuplexStream) {
    assert!(matches!(
        timeout(Duration::from_secs(16), codec::read(peer))
            .await
            .unwrap()
            .unwrap(),
        Message::Ping { nonce: 1, .. }
    ));
}

#[tokio::test(start_paused = true)]
async fn a_network_change_debounces_then_races_all_better_targets_and_replaces_the_session() {
    let (source, mut attempts, mut peer, task) =
        connected_source(MIXED, TAILNET[0], Some("studio.lan"));
    let changed = network_change(&source, &mut peer).await;
    expect_lan_dials(&mut attempts, changed).await;
    let replacement = timeout(WAIT, task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(replacement.target.host, "studio.lan");
    assert_eq!(replacement.route, Route::Lan);
    replacement.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_promotion_leaves_the_original_session_serving() {
    let (source, mut attempts, mut peer, task) = connected_source(MIXED, TAILNET[0], None);
    let changed = network_change(&source, &mut peer).await;
    expect_lan_dials(&mut attempts, changed).await;
    next_heartbeat(&mut peer).await;
    source.control.send_modify(|state| state.stop = true);
    assert!(
        timeout(WAIT, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .is_none()
    );
    assert!(attempts.try_recv().is_err(), "extra promotion dial");
}

#[tokio::test(start_paused = true)]
async fn a_network_change_never_promotes_a_lan_or_races_same_route_targets() {
    for (routes, current) in [(MIXED, MIXED[0]), (TAILNET, TAILNET[0])] {
        let (source, mut attempts, mut peer, task) = connected_source(routes, current, None);
        network_change(&source, &mut peer).await;
        next_heartbeat(&mut peer).await;
        assert!(
            attempts.try_recv().is_err(),
            "redialed a route that cannot improve"
        );
        source.control.send_modify(|state| state.stop = true);
        assert!(
            timeout(WAIT, task)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .is_none()
        );
    }
}
