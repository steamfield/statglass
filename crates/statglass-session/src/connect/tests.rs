use super::*;
use crate::{BoxFuture, Close, MAX_TARGETS, RemoteCommand, Route, StderrTail};
use statglass_proto::HelloAck;
use statglass_schema::{HostIdentity, HostInfo, OsKind, lock::LockExt};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering::SeqCst},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, duplex},
    sync::mpsc,
    task::JoinHandle,
    time::sleep,
};
use uuid::Uuid;

const LOCAL: HostId = HostId(Uuid::from_u128(1));
const HOST: HostId = HostId(Uuid::from_u128(2));
const OTHER: HostId = HostId(Uuid::from_u128(3));

fn hello(id: HostId) -> Hello {
    Hello {
        proto_version: statglass_proto::PROTO_VERSION,
        min_compatible: statglass_proto::MIN_COMPATIBLE,
        app_version: "test peer".into(),
        host: HostIdentity {
            id,
            display_name: "Studio".into(),
            info: HostInfo {
                os: OsKind::MacOs,
                os_version: String::new(),
                model: None,
                chip: None,
                chip_known: false,
                cpu_topology: Vec::new(),
                mem_total_bytes: 0,
                boot_time_ms: 0,
                gpu_dvfs_mhz: Vec::new(),
                kernel: None,
                boot_mounts: Vec::new(),
            },
        },
        db_instance_uuid: Uuid::nil(),
        capabilities: Default::default(),
        features: statglass_proto::local_features(),
    }
}

#[derive(Default)]
struct Step {
    dial_ms: u64,
    greeting_ms: u64,
    frame: Option<Vec<u8>>,
    failure: Option<fn() -> RemoteError>,
    stderr: &'static str,
    stderr_on_close: &'static str,
    ack: AckBehavior,
    dropped: Arc<AtomicUsize>,
    closed: Arc<AtomicUsize>,
}

#[derive(Clone, Copy, Default)]
enum AckBehavior {
    #[default]
    Read,
    Stall,
    Close,
}

impl Step {
    fn answers(ms: u64, id: HostId) -> Self {
        Self::with_hello(ms, hello(id))
    }

    fn with_hello(ms: u64, hello: Hello) -> Self {
        Self {
            greeting_ms: ms,
            frame: Some(statglass_proto::encode_frame(&Message::Hello(Box::new(hello))).unwrap()),
            ..Self::default()
        }
    }

    fn fails(ms: u64, failure: fn() -> RemoteError) -> Self {
        Self {
            dial_ms: ms,
            failure: Some(failure),
            ..Self::default()
        }
    }
}

struct Attempt(Arc<AtomicUsize>);

impl Drop for Attempt {
    fn drop(&mut self) {
        self.0.fetch_add(1, SeqCst);
    }
}

struct FakeClose {
    _attempt: Attempt,
    peer: JoinHandle<()>,
    closed: Arc<AtomicUsize>,
    stderr: StderrTail,
    stderr_on_close: &'static str,
}

impl Drop for FakeClose {
    fn drop(&mut self) {
        self.peer.abort();
    }
}

impl Close for FakeClose {
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            self.closed.fetch_add(1, SeqCst);
            self.stderr.push(self.stderr_on_close.as_bytes());
        })
    }
}

struct ScriptedDialer {
    steps: Vec<Step>,
    dials: AtomicUsize,
    acks: mpsc::UnboundedSender<HelloAck>,
    classified: Mutex<Vec<(HandshakeFailure, String, usize)>>,
}

impl Dialer for ScriptedDialer {
    fn dial<'a>(
        &'a self,
        endpoint: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, Result<DialedStream>> {
        Box::pin(async move {
            self.dials.fetch_add(1, SeqCst);
            let index = endpoint
                .targets
                .iter()
                .position(|item| item == target)
                .unwrap();
            let step = &self.steps[index];
            let attempt = Attempt(step.dropped.clone());
            delay(step.dial_ms).await;
            if let Some(failure) = step.failure {
                return Err(failure());
            }
            let ack = step.ack;
            let (client, mut peer) = duplex(if matches!(ack, AckBehavior::Stall) {
                1
            } else {
                4096
            });
            let acks = self.acks.clone();
            let greeting_ms = step.greeting_ms;
            let frame = step.frame.clone();
            let peer = tokio::spawn(async move {
                delay(greeting_ms).await;
                if let Some(frame) = frame {
                    if peer.write_all(&frame).await.is_err() {
                        return;
                    }
                    if matches!(ack, AckBehavior::Close) {
                        return;
                    }
                    if matches!(ack, AckBehavior::Read) {
                        let Ok(len) = peer.read_u32().await else {
                            return;
                        };
                        let mut body = vec![0; len as usize];
                        if peer.read_exact(&mut body).await.is_err() {
                            return;
                        }
                        if let Message::HelloAck(ack) =
                            statglass_proto::decode_message(&body).unwrap()
                        {
                            let _ = acks.send(ack);
                        }
                    }
                }
                pending::<()>().await;
            });
            let (reader, writer) = tokio::io::split(client);
            let stderr = StderrTail::default();
            stderr.push(step.stderr.as_bytes());
            Ok(DialedStream {
                reader: Box::pin(reader),
                writer: Box::pin(writer),
                stderr: stderr.clone(),
                close: Box::new(FakeClose {
                    _attempt: attempt,
                    peer,
                    closed: step.closed.clone(),
                    stderr,
                    stderr_on_close: step.stderr_on_close,
                }),
            })
        })
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        let closed = self.steps.iter().map(|step| step.closed.load(SeqCst)).sum();
        self.classified
            .lock_ok()
            .push((failure.outcome, failure.stderr.into(), closed));
        RemoteError::Transport("scripted classification".into())
    }
}

async fn delay(ms: u64) {
    if ms != 0 {
        sleep(Duration::from_millis(ms)).await;
    }
}

fn fixture(steps: Vec<Step>) -> (ScriptedDialer, Endpoint, mpsc::UnboundedReceiver<HelloAck>) {
    let targets = [
        (Route::Lan, "studio.local"),
        (Route::Tailscale, "studio.tailnet.ts.net"),
        (Route::Tailscale, "100.64.0.2"),
        (Route::Tailscale, "spare"),
    ];
    let count = steps.len();
    let (acks, rx) = mpsc::unbounded_channel();
    (
        ScriptedDialer {
            dials: AtomicUsize::new(0),
            classified: Mutex::new(Vec::new()),
            steps,
            acks,
        },
        Endpoint {
            targets: targets
                .into_iter()
                .take(count)
                .map(|(route, host)| Target {
                    route,
                    host: host.into(),
                })
                .collect(),
            port: None,
            user: None,
            host_keys: Vec::new(),
            command: RemoteCommand::default(),
        },
        rx,
    )
}

fn failed(result: Result<SshSession>) -> RemoteError {
    result.err().expect("the scripted connection should fail")
}

#[tokio::test(start_paused = true)]
async fn one_target_returns_its_error_unwrapped() {
    let (dialer, endpoint, _) = fixture(vec![Step::fails(0, || RemoteError::Busy("busy".into()))]);
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::Busy(text) if text == "busy"
    ));
}

#[tokio::test(start_paused = true)]
async fn preferred_success_within_grace_drops_the_fallback() {
    let (dialer, endpoint, _) = fixture(vec![Step::answers(200, HOST), Step::answers(0, HOST)]);
    let start = Instant::now();
    let session = connect(&dialer, &endpoint, LOCAL, None).await.unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(200));
    assert_eq!(session.target, endpoint.targets[0]);
    assert_eq!(session.route, Route::Lan);
    assert_eq!(dialer.steps[0].dropped.load(SeqCst), 0);
    assert_eq!(dialer.steps[1].dropped.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn grace_expiry_picks_the_fallback_and_cancels_preferred_dial() {
    let slow = Step {
        dial_ms: 1000,
        ..Step::default()
    };
    let (dialer, endpoint, _) = fixture(vec![slow, Step::answers(0, HOST)]);
    let start = Instant::now();
    let session = connect(&dialer, &endpoint, LOCAL, None).await.unwrap();
    assert_eq!(start.elapsed(), ROUTE_GRACE);
    assert_eq!(session.target, endpoint.targets[1]);
    assert_eq!(dialer.steps[0].dropped.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn preferred_retryable_failure_ends_the_wait_for_a_fallback() {
    let lan = Step::fails(200, || RemoteError::Transport("offline".into()));
    let (dialer, endpoint, _) = fixture(vec![lan, Step::answers(0, HOST)]);
    let start = Instant::now();
    let session = connect(&dialer, &endpoint, LOCAL, None).await.unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(200));
    assert_eq!(session.target, endpoint.targets[1]);
}

#[tokio::test(start_paused = true)]
async fn non_retryable_failure_ends_the_race_during_grace() {
    let bad_key = Step::fails(200, || RemoteError::HostKey("changed".into()));
    let (dialer, endpoint, _) = fixture(vec![Step::default(), Step::answers(0, HOST), bad_key]);
    let start = Instant::now();
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::HostKey(text) if text == "changed"
    ));
    assert_eq!(start.elapsed(), Duration::from_millis(200));
    assert_eq!(dialer.steps[0].dropped.load(SeqCst), 1);
    assert_eq!(dialer.steps[1].dropped.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn preferred_success_wins_over_host_key_failure_in_the_same_poll() {
    let bad_key = Step::fails(100, || RemoteError::HostKey("changed".into()));
    let (dialer, endpoint, _) = fixture(vec![Step::answers(0, HOST), bad_key]);
    let start = Instant::now();
    let connection = connect(&dialer, &endpoint, LOCAL, None);
    tokio::pin!(connection);
    poll_fn(|cx| {
        assert!(connection.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    // Leave the race unpolled until the greeting and the failure are both ready.
    sleep(Duration::from_millis(100)).await;

    let session = connection.await.unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(100));
    assert_eq!(session.target, endpoint.targets[0]);
}

#[tokio::test(start_paused = true)]
async fn successful_routes_must_identify_the_same_host() {
    let (dialer, endpoint, _) = fixture(vec![Step::answers(200, HOST), Step::answers(0, OTHER)]);
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::Identity(text) if text == "LAN and Tailscale identify different Macs"
    ));
    assert_eq!(dialer.steps[0].dropped.load(SeqCst), 1);
    assert_eq!(dialer.steps[1].dropped.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn same_route_identity_conflict_names_the_preferred_target_first() {
    let (dialer, endpoint, _) = fixture(vec![
        Step::default(),
        Step::answers(200, OTHER),
        Step::answers(0, HOST),
    ]);
    let start = Instant::now();
    let error = failed(connect(&dialer, &endpoint, LOCAL, None).await);
    assert_eq!(start.elapsed(), Duration::from_millis(200));
    assert_eq!(dialer.steps[1].dropped.load(SeqCst), 1);
    assert_eq!(dialer.steps[2].dropped.load(SeqCst), 1);
    let RemoteError::Identity(text) = error else {
        panic!("expected an identity conflict, got {error:?}");
    };
    assert_eq!(
        text,
        "studio.tailnet.ts.net and 100.64.0.2 identify different hosts"
    );
}

#[tokio::test(start_paused = true)]
async fn all_retryable_failures_keep_the_target_order_and_aliases() {
    let (dialer, endpoint, _) = fixture(vec![
        Step::fails(200, || RemoteError::Unreachable {
            kind: crate::UnreachableKind::NameNotResolved,
            detail: "dns failed".into(),
        }),
        Step::fails(100, || RemoteError::Timeout("timed out".into())),
        Step::fails(0, || RemoteError::Transport("offline".into())),
    ]);
    let error = failed(connect(&dialer, &endpoint, LOCAL, None).await);
    assert!(error.retryable());
    assert_eq!(
        error.to_string(),
        "LAN: dns failed; Tailscale: timed out; Tailscale: offline"
    );
    let RemoteError::Routes(routes) = error else {
        panic!("{error:?}")
    };
    assert_eq!(routes.len(), endpoint.targets.len());
    for (failure, target) in routes.iter().zip(&endpoint.targets) {
        assert_eq!((failure.route, &failure.host), (target.route, &target.host));
    }
    assert!(matches!(routes[0].error, RemoteError::Unreachable { .. }));
    assert!(matches!(routes[1].error, RemoteError::Timeout(_)));
    assert!(matches!(routes[2].error, RemoteError::Transport(_)));
}

#[tokio::test(start_paused = true)]
async fn stopped_agent_wins_when_all_failures_are_retryable() {
    let (dialer, endpoint, _) = fixture(vec![
        Step::fails(100, || RemoteError::Timeout("timed out".into())),
        Step::fails(0, || RemoteError::AgentNotRunning("studio".into())),
    ]);
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::AgentNotRunning(text)
            if text == "LAN: timed out; Tailscale: StatGlass agent is not running on studio"
    ));
}

#[tokio::test(start_paused = true)]
async fn preferred_error_keeps_the_most_actionable_route_error() {
    use crate::{AGENT_NOT_RUNNING, APP_NOT_RUNNING, MONITORING_OFF};
    use ConnectionFailureKind as K;

    let marker = |stderr_on_close| Step {
        stderr_on_close,
        ..Step::default()
    };
    let missing_key = || {
        RemoteError::PhoneKeyUnavailable("Could not load the phone key (OSStatus -25300)".into())
    };
    for (steps, expected, message) in [
        (
            vec![
                marker(AGENT_NOT_RUNNING),
                marker(APP_NOT_RUNNING),
                marker("login banner"),
            ],
            K::AppNotRunning,
            "StatGlass isn't running on studio.tailnet.ts.net",
        ),
        (
            vec![
                marker(AGENT_NOT_RUNNING),
                marker(APP_NOT_RUNNING),
                marker(MONITORING_OFF),
            ],
            K::MonitoringOff,
            "Remote monitoring is off on 100.64.0.2",
        ),
        (
            vec![Step::fails(50, missing_key), Step::fails(0, missing_key)],
            K::PhoneKeyUnavailable,
            "Could not load the phone key (OSStatus -25300)",
        ),
        (
            vec![
                Step::fails(0, || RemoteError::Timeout("LAN timed out".into())),
                Step::fails(50, || {
                    RemoteError::SignerInternal("Native signer failed".into())
                }),
            ],
            K::Internal,
            "Native signer failed",
        ),
        (
            vec![
                Step::fails(0, || RemoteError::Timeout("LAN timed out".into())),
                Step::fails(50, || RemoteError::TailscaleSsh("100.64.0.2".into())),
            ],
            K::TailscaleSsh,
            "Tailscale SSH answered on 100.64.0.2 instead of OpenSSH",
        ),
    ] {
        let (dialer, endpoint, _) = fixture(steps);
        let error = failed(connect(&dialer, &endpoint, LOCAL, None).await);
        assert!(
            matches!(
                (expected, &error),
                (K::AppNotRunning, RemoteError::AppNotRunning(_))
                    | (K::MonitoringOff, RemoteError::MonitoringOff(_))
                    | (K::PhoneKeyUnavailable, RemoteError::PhoneKeyUnavailable(_))
                    | (K::Internal, RemoteError::SignerInternal(_))
                    | (K::TailscaleSsh, RemoteError::TailscaleSsh(_))
            ),
            "{error:?}"
        );
        assert_eq!(ConnectionFailureKind::from_error(&error), expected);
        assert!(error.retryable());
        assert_eq!(error.to_string(), message);
    }
}

#[tokio::test(start_paused = true)]
async fn helper_markers_from_stderr_are_classified_before_the_dialer() {
    use crate::{APP_NOT_RUNNING, ConnectionFailureKind, MONITORING_OFF};
    for (marker, kind) in [
        (APP_NOT_RUNNING, ConnectionFailureKind::AppNotRunning),
        (MONITORING_OFF, ConnectionFailureKind::MonitoringOff),
    ] {
        let (dialer, endpoint, _) = fixture(vec![Step {
            stderr: "login banner\n",
            stderr_on_close: marker,
            ..Step::default()
        }]);
        let error = failed(connect(&dialer, &endpoint, LOCAL, None).await);
        assert_eq!(ConnectionFailureKind::from_error(&error), kind);
        assert!(error.retryable());
        assert!(error.to_string().ends_with(&endpoint.targets[0].host));
        assert!(dialer.classified.lock_ok().is_empty());
    }
}

#[tokio::test(start_paused = true)]
async fn address_fallback_waits_for_magic_dns_after_lan_fails() {
    let (dialer, endpoint, _) = fixture(vec![
        Step::fails(50, || RemoteError::Transport("offline".into())),
        Step::default(),
        Step::answers(0, HOST),
    ]);
    let start = Instant::now();
    let session = connect(&dialer, &endpoint, LOCAL, None).await.unwrap();
    assert_eq!(start.elapsed(), ROUTE_GRACE);
    assert_eq!(session.target, endpoint.targets[2]);
    assert_eq!(dialer.dials.load(SeqCst), 3);
    assert_eq!(dialer.steps[1].dropped.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_better_fallback_does_not_restart_grace() {
    let (dialer, endpoint, _) = fixture(vec![
        Step::default(),
        Step::answers(400, HOST),
        Step::answers(0, HOST),
    ]);
    let start = Instant::now();
    let session = connect(&dialer, &endpoint, LOCAL, None).await.unwrap();
    assert_eq!(start.elapsed(), ROUTE_GRACE);
    assert_eq!(session.target, endpoint.targets[1]);
}

#[tokio::test(start_paused = true)]
async fn hello_timeout_includes_dial_time_and_closes_before_classifying() {
    let step = Step {
        dial_ms: 4000,
        stderr: "banner\n",
        stderr_on_close: "last diagnostic\n",
        ..Step::default()
    };
    let (dialer, endpoint, _) = fixture(vec![step]);
    let start = Instant::now();
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::Transport(text) if text == "scripted classification"
    ));
    assert_eq!(start.elapsed(), HANDSHAKE_TIMEOUT);
    assert_eq!(
        *dialer.classified.lock_ok(),
        [(
            HandshakeFailure::TimedOut,
            "banner\nlast diagnostic".into(),
            1
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn dial_that_exceeds_the_deadline_is_cancelled() {
    let (dialer, endpoint, _) = fixture(vec![Step {
        dial_ms: 11_000,
        ..Step::default()
    }]);
    let start = Instant::now();
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::Timeout(text) if text == "studio.local: The host did not answer in time."
    ));
    assert_eq!(start.elapsed(), HANDSHAKE_TIMEOUT);
    assert_eq!(dialer.steps[0].dropped.load(SeqCst), 1);
    assert!(dialer.classified.lock_ok().is_empty());
}

#[tokio::test(start_paused = true)]
async fn ack_write_shares_the_dial_deadline() {
    let (dialer, endpoint, _) = fixture(vec![Step {
        dial_ms: 2000,
        ack: AckBehavior::Stall,
        ..Step::answers(0, HOST)
    }]);
    let start = Instant::now();
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::Transport(text) if text == "peer stopped reading"
    ));
    assert_eq!(start.elapsed(), HANDSHAKE_TIMEOUT);
    assert_eq!(dialer.steps[0].closed.load(SeqCst), 1);
    assert_eq!(dialer.steps[0].dropped.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn failed_ack_write_closes_the_stream() {
    let (dialer, endpoint, _) = fixture(vec![Step {
        ack: AckBehavior::Close,
        ..Step::answers(0, HOST)
    }]);
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::Io(error) if error.kind() == std::io::ErrorKind::BrokenPipe
    ));
    assert_eq!(dialer.steps[0].closed.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn marker_line_from_cleanup_takes_priority_over_dialer_classification() {
    let (dialer, endpoint, _) = fixture(vec![Step {
        frame: Some(
            statglass_proto::encode_frame(&Message::Ping {
                nonce: 42,
                t0_ms: 0,
            })
            .unwrap(),
        ),
        stderr: "login banner\n",
        stderr_on_close: "statglass-agent: not running\n",
        ..Step::default()
    }]);
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::AgentNotRunning(host) if host == endpoint.targets[0].host
    ));
    assert_eq!(dialer.steps[0].closed.load(SeqCst), 1);
    assert!(dialer.classified.lock_ok().is_empty());
}

#[tokio::test(start_paused = true)]
async fn restricted_command_refusal_is_incompatible_without_a_version_direction() {
    assert_restricted_refusal(crate::AGENT_COMMAND_NOT_ALLOWED).await;
}

#[tokio::test(start_paused = true)]
async fn a_mac_helpers_restricted_refusal_is_incompatible() {
    assert_restricted_refusal(crate::HELPER_COMMAND_NOT_ALLOWED).await;
}

async fn assert_restricted_refusal(marker: &'static str) {
    let (dialer, endpoint, _) = fixture(vec![Step {
        frame: Some(Vec::new()),
        ack: AckBehavior::Close,
        stderr: "login banner\n",
        stderr_on_close: marker,
        ..Step::default()
    }]);
    let error = failed(connect(&dialer, &endpoint, LOCAL, None).await);
    assert!(matches!(&error, RemoteError::Incompatible(reason)
        if reason == &format!("{}: the host refused the restricted command", endpoint.targets[0].host)));
    assert!(!error.retryable());
}

#[tokio::test(start_paused = true)]
async fn an_oversized_greeting_is_rejected_from_its_prefix() {
    let (dialer, endpoint, _) = fixture(vec![Step {
        frame: Some((1024 * 1024 + 1_u32).to_be_bytes().to_vec()),
        ..Step::default()
    }]);
    failed(connect(&dialer, &endpoint, LOCAL, None).await);
    assert_eq!(
        *dialer.classified.lock_ok(),
        [(HandshakeFailure::Invalid, String::new(), 1)]
    );
}

async fn assert_greeting_failure(frame: Vec<u8>, outcome: HandshakeFailure) {
    let (dialer, endpoint, _) = fixture(vec![Step {
        frame: Some(frame),
        ack: AckBehavior::Close,
        ..Step::default()
    }]);
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::Transport(text) if text == "scripted classification"
    ));
    assert_eq!(*dialer.classified.lock_ok(), [(outcome, String::new(), 1)]);
}

#[tokio::test(start_paused = true)]
async fn peer_closing_before_the_first_byte_reads_as_closed() {
    assert_greeting_failure(Vec::new(), HandshakeFailure::Closed).await;
}

#[tokio::test(start_paused = true)]
async fn ping_as_the_first_frame_reads_as_not_hello() {
    let ping = statglass_proto::encode_frame(&Message::Ping {
        nonce: 42,
        t0_ms: 0,
    })
    .unwrap();
    assert_greeting_failure(ping, HandshakeFailure::NotHello).await;
}

#[tokio::test(start_paused = true)]
async fn a_zero_length_greeting_reads_as_invalid() {
    assert_greeting_failure(0_u32.to_be_bytes().to_vec(), HandshakeFailure::Invalid).await;
}

#[tokio::test(start_paused = true)]
async fn an_undecodable_greeting_body_reads_as_invalid() {
    assert_greeting_failure(vec![0, 0, 0, 1, 0xff], HandshakeFailure::Invalid).await;
}

#[tokio::test(start_paused = true)]
async fn hello_from_this_device_is_rejected() {
    let (dialer, endpoint, _) = fixture(vec![Step::answers(0, LOCAL)]);
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, None).await),
        RemoteError::Identity(text) if text == "cannot connect this Mac to itself"
    ));
    assert_eq!(dialer.steps[0].closed.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn hello_from_an_unpaired_identity_is_rejected() {
    let (dialer, endpoint, _) = fixture(vec![Step::answers(0, OTHER)]);
    assert!(matches!(
        failed(connect(&dialer, &endpoint, LOCAL, Some(HOST)).await),
        RemoteError::IdentityMismatch { alias, expected: HOST, actual: OTHER }
            if alias == endpoint.targets[0].host
    ));
    assert_eq!(dialer.steps[0].closed.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn incompatible_hello_preserves_the_peer_app_version_and_update_direction() {
    use crate::IncompatibleSide::{App, Host};
    let old = statglass_proto::MIN_COMPATIBLE - 1;
    let new = statglass_proto::PROTO_VERSION + 1;
    for (min_compatible, proto_version, expected) in [
        (old, old, Some(Host)),
        (new, new, Some(App)),
        (new, old, None), // A malformed range gives no upgrade direction.
    ] {
        let greeting = Hello {
            proto_version,
            min_compatible,
            ..hello(HOST)
        };
        let (dialer, endpoint, _) = fixture(vec![Step::with_hello(0, greeting)]);
        assert!(
            matches!(
                failed(connect(&dialer, &endpoint, LOCAL, None).await),
                RemoteError::IncompatiblePeer { version, side, .. }
                    if version == "test peer" && side == expected
            ),
            "peer range {min_compatible}..={proto_version}"
        );
        assert_eq!(dialer.steps[0].closed.load(SeqCst), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn successful_hello_writes_the_negotiated_ack() {
    let mut greeting = hello(HOST);
    greeting.features.insert("unknown-to-local".into());
    let (dialer, endpoint, mut acks) = fixture(vec![Step::with_hello(0, greeting)]);
    let session = connect(&dialer, &endpoint, LOCAL, Some(HOST))
        .await
        .unwrap();
    let ack = timeout_at(Instant::now() + Duration::from_secs(1), acks.recv())
        .await
        .unwrap();
    assert_eq!(
        ack,
        Some(HelloAck {
            proto_version: statglass_proto::PROTO_VERSION,
            features: statglass_proto::local_features(),
        })
    );
    assert_eq!(session.hello.host.id, HOST);
    assert_eq!(session.negotiated.ack(), ack.unwrap());
}

#[tokio::test(start_paused = true)]
async fn invalid_endpoints_do_not_dial_any_targets() {
    let (dialer, valid, _) = fixture(vec![Step::answers(0, HOST)]);
    let invalid = [
        Endpoint {
            targets: vec![],
            ..valid.clone()
        },
        Endpoint {
            targets: vec![valid.targets[0].clone(); MAX_TARGETS + 1],
            ..valid.clone()
        },
        Endpoint {
            targets: vec![Target {
                route: Route::Lan,
                host: "-option".into(),
            }],
            ..valid.clone()
        },
        Endpoint {
            port: Some(0),
            ..valid.clone()
        },
        Endpoint {
            user: Some("two words".into()),
            ..valid.clone()
        },
        Endpoint {
            user: Some("-user".into()),
            ..valid
        },
    ];
    for endpoint in invalid {
        assert!(matches!(
            failed(connect(&dialer, &endpoint, LOCAL, None).await),
            RemoteError::Protocol(_)
        ));
    }
    assert_eq!(dialer.dials.load(SeqCst), 0);
}
