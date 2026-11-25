//! Run against a seeded `scripts/ssh-docker/serve.sh --seed` fixture using its
//! STATGLASS_SSH_DOCKER_* environment and
//! `cargo test -p statglass-mobile --test docker_demand -- --ignored --nocapture`.

mod support;

use std::io;
use std::pin::Pin;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll, Waker, ready};
use std::time::Duration;

use serde_json::{Value, json};
use statglass_engine::{BusMsg, LiveHub, Recv, Source, SourceSink, wall_ms};
use statglass_ipc::mobile::{MobileCommand, MobileConfig};
use statglass_mobile::{CoreEvents, MobileCore, NativeSigner, NativeSignerError};
use statglass_proto::{HistoryAnswer, HistoryQuery};
use statglass_schema::{HostId, HostInfo, HostRecord, Module, OsKind, SeriesSelector};
use statglass_session::{
    BoxFuture, DialFailure, DialedStream, Dialer, Endpoint, PinnedHostKey, RemoteError,
    RemoteSource, Route, SourceOptions, Target,
};
use statglass_ssh::{RusshDialer, Signer, SoftwareSigner};
use tokio::io::{AsyncRead, ReadBuf};
use tokio::runtime::{Handle, Runtime};
use tokio::time::{Instant, MissedTickBehavior, timeout};

use support::DockerFixture;

const SAMPLE: Duration = Duration::from_secs(60);
const HOUR_MS: i64 = 3_600_000;
const RANGES: [i64; 4] = [1, 24, 168, 720];

fn fixture(name: &str) -> String {
    let key = format!("STATGLASS_SSH_DOCKER_{name}");
    std::env::var(&key).unwrap_or_else(|_| panic!("missing {key}"))
}

fn restricted_key() -> SoftwareSigner {
    let der =
        std::fs::read(fixture("RESTRICTED_KEY")).expect("read the restricted SSH fixture key");
    SoftwareSigner::from_pkcs8_der(&der).expect("decode the restricted SSH fixture key")
}

struct FixtureSigner(Arc<SoftwareSigner>);

impl NativeSigner for FixtureSigner {
    fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
        Ok(self.0.public_key().to_vec())
    }

    fn sign(&self, message: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
        let mut signing = self.0.sign(message);
        let Poll::Ready(result) = signing
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        else {
            panic!("software signing is synchronous");
        };
        result.map_err(|error| NativeSignerError::Unexpected {
            message: error.to_string(),
        })
    }
}

struct ExplicitBytes {
    dialer: RusshDialer,
    received: Arc<AtomicU64>,
}

struct Counter {
    reader: Pin<Box<dyn AsyncRead + Send>>,
    received: Arc<AtomicU64>,
}

impl AsyncRead for Counter {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        ready!(self.reader.as_mut().poll_read(cx, buf))?;
        self.received
            .fetch_add((buf.filled().len() - before) as u64, Ordering::Relaxed);
        Poll::Ready(Ok(()))
    }
}

impl Dialer for ExplicitBytes {
    fn dial<'a>(
        &'a self,
        endpoint: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, statglass_session::Result<DialedStream>> {
        Box::pin(async {
            let mut stream = self.dialer.dial(endpoint, target).await?;
            stream.reader = Box::pin(Counter {
                reader: stream.reader,
                received: self.received.clone(),
            });
            Ok(stream)
        })
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        self.dialer.classify(failure)
    }
}

fn source(bytes: Arc<AtomicU64>) -> Arc<RemoteSource> {
    let signer = restricted_key();
    let pin = fixture("HOST_KEY");
    let (algorithm, sha256) = pin
        .split_once(' ')
        .expect("split the SSH host key algorithm and fingerprint");
    RemoteSource::with_options(
        HostRecord {
            id: HostId(fixture("HOST_ID").parse().expect("parse the agent host ID")),
            display_name: "Docker agent".into(),
            is_local: false,
            info: HostInfo {
                os: OsKind::Linux,
                os_version: String::new(),
                model: None,
                chip: None,
                chip_known: false,
                cpu_topology: vec![],
                mem_total_bytes: 0,
                boot_time_ms: 0,
                gpu_dvfs_mhz: vec![],
                boot_mounts: vec![],
                kernel: None,
            },
        },
        HostId(
            "00000000-0000-0000-0000-000000000001"
                .parse()
                .expect("parse the phone host ID"),
        ),
        Arc::new(ExplicitBytes {
            dialer: RusshDialer::new(Arc::new(signer)),
            received: bytes,
        }),
        Endpoint {
            targets: vec![Target {
                host: fixture("HOST"),
                route: Route::Lan,
            }],
            port: Some(fixture("PORT").parse().expect("parse the fixture port")),
            user: Some(fixture("USER")),
            host_keys: vec![PinnedHostKey {
                algorithm: algorithm.into(),
                sha256: sha256.into(),
            }],
            command: statglass_session::RemoteCommand::Restricted {
                forced: statglass_session::ForcedToken::Serve,
            },
        },
        Arc::new(|_| {}),
        None,
        SourceOptions {
            runtime: Some(Handle::current()),
            ..Default::default()
        },
    )
}

async fn wait_for(hub: &LiveHub, predicate: impl Fn(BusMsg) -> bool) {
    let mut sub = hub.subscribe();
    timeout(Duration::from_secs(15), async {
        loop {
            if let Recv::Msg(message) = sub.recv_event().await
                && predicate(message)
            {
                return;
            }
        }
    })
    .await
    .expect("agent supplies the requested live data");
}

async fn bytes_per_sec(hub: &LiveHub, counter: &AtomicU64) -> f64 {
    let start = Instant::now();
    let before = counter.load(Ordering::Relaxed);
    let mut sub = hub.subscribe();
    assert!(
        tokio::time::timeout_at(start + SAMPLE, async {
            loop {
                assert!(!matches!(sub.recv_event().await, Recv::Closed));
            }
        })
        .await
        .is_err()
    );
    (counter.load(Ordering::Relaxed) - before) as f64 / start.elapsed().as_secs_f64()
}

fn docker(args: &[&str]) -> String {
    let output = Command::new("docker")
        .args(["exec", &fixture("CONTAINER")])
        .args(args)
        .output()
        .expect("run a command in the seeded Docker fixture");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("decode Docker stdout")
        .trim()
        .to_owned()
}

fn cpu_ticks(pid: &str) -> u64 {
    let stat = docker(&["cat", &format!("/proc/{pid}/stat")]);
    let (_, fields) = stat
        .rsplit_once(')')
        .expect("find process fields after the executable name");
    // The process name can contain spaces. The remaining fields begin with state (3).
    fields
        .split_whitespace()
        .skip(11)
        .take(2)
        .map(|value| value.parse::<u64>().expect("parse agent CPU ticks"))
        .sum()
}

async fn history(source: &RemoteSource, hours: i64) -> HistoryAnswer {
    let now = wall_ms();
    let answer = source
        .history(HistoryQuery {
            series: vec![SeriesSelector {
                metric: statglass_schema::MetricId::from_static("cpu.total"),
                labels: Default::default(),
            }],
            from_ms: now - hours * HOUR_MS,
            to_ms: None,
            max_points: 200,
            events_for: Some(Module::Cpu),
        })
        .await
        .expect("read the seeded CPU history");
    let points = &answer.series[0].points;
    assert!(points.len() <= 200, "host enforced the requested budget");
    assert!(
        points
            .first()
            .is_some_and(|point| point.0 < now - hours * HOUR_MS / 2),
        "query should hit the seeded range"
    );
    answer
}

async fn measure_history(source: &RemoteSource, bytes: &AtomicU64) {
    let socket = fixture("SOCKET");
    let pid = docker(&[
        "cat",
        &format!(
            "{}/agent.pid",
            socket
                .rsplit_once('/')
                .expect("read the agent socket directory")
                .0
        ),
    ]);
    let ticks_per_sec: f64 = docker(&["getconf", "CLK_TCK"])
        .parse()
        .expect("read the Linux clock tick rate");
    for hours in RANGES {
        let cpu_before = cpu_ticks(&pid);
        let bytes_before = bytes.load(Ordering::Relaxed);
        let started = Instant::now();
        history(source, hours).await;
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let transferred = bytes.load(Ordering::Relaxed) - bytes_before;
        let cpu_ms = (cpu_ticks(&pid) - cpu_before) as f64 / ticks_per_sec * 1_000.0;
        println!("history {hours}h: {transferred} B, {cpu_ms:.2} CPU ms, {wall_ms:.2} wall ms");
    }

    let cpu_before = cpu_ticks(&pid);
    let started = Instant::now();
    let mut interval = tokio::time::interval_at(started, Duration::from_millis(500));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    for hours in RANGES.into_iter().cycle().take(60) {
        interval.tick().await;
        history(source, hours).await;
    }
    interval.tick().await;
    let wall_sec = started.elapsed().as_secs_f64();
    let cpu_sec = (cpu_ticks(&pid) - cpu_before) as f64 / ticks_per_sec;
    println!(
        "history range flipping: {:.2} CPU ms in {wall_sec:.2} s ({:.3}% of one core)",
        cpu_sec * 1_000.0,
        cpu_sec / wall_sec * 100.0
    );
}

fn established_ssh() -> usize {
    docker(&["cat", "/proc/net/tcp", "/proc/net/tcp6"])
        .lines()
        .filter(|line| {
            let mut fields = line.split_whitespace().skip(1);
            fields.next().is_some_and(|local| local.ends_with(":0016"))
                && fields.nth(1) == Some("01")
        })
        .count()
}

fn response(raw: String) -> Value {
    let result: Value = serde_json::from_str(&raw).expect("decode the mobile reply");
    assert_eq!(result["status"], "ok", "{result}");
    result["data"].clone()
}

async fn core_call(core: &MobileCore, method: &str, args: Value) -> Value {
    response(core.call(method.to_owned(), args.to_string()).await)
}

fn measure_park_grace(runtime: &Runtime) {
    let mut fixture = DockerFixture::new();
    fixture.host.command = MobileCommand::Restricted;
    fixture.key = Arc::new(restricted_key());
    let core = MobileCore::new(
        Arc::new(FixtureSigner(fixture.key.clone())),
        fixture.events.clone(),
    );
    let host = fixture.host.id;
    let config = MobileConfig {
        hosts: vec![fixture.host.clone()],
        ..Default::default()
    };
    assert_eq!(
        response(
            core.start(
                fixture
                    .dir
                    .path()
                    .to_str()
                    .expect("read the phone data directory")
                    .into(),
                serde_json::to_string(&config).expect("serialize the fixture host")
            )
        ),
        Value::Null
    );
    runtime.block_on(park_round_trip(&core, &mut fixture, host));
}

async fn park_round_trip(core: &MobileCore, fixture: &mut DockerFixture, host: HostId) {
    let demand = json!({"demand": [{"host": host, "level": "full"}]});
    core_call(core, "set_demand", demand.clone()).await;
    core_call(core, "subscribe_live", json!({"host": host, "stream": 1})).await;
    fixture.expect_cpu(1).await;
    assert_eq!(established_ssh(), 1);

    core_call(core, "set_demand", json!({"demand": []})).await;
    let started = Instant::now();
    let mut samples = tokio::time::interval(Duration::from_millis(250));
    let closed = timeout(Duration::from_secs(19), async {
        loop {
            samples.tick().await;
            if established_ssh() == 0 {
                break started.elapsed();
            }
        }
    })
    .await
    .expect("sshd closes after the grace period");
    assert!(
        closed >= Duration::from_millis(14_900),
        "SSH closed early at {closed:?}"
    );

    core_call(core, "set_demand", demand).await;
    timeout(Duration::from_secs(8), async {
        loop {
            samples.tick().await;
            let status = core_call(core, "list_remote_hosts", Value::Null).await;
            if status[0]["connection"]["state"] == "connected" {
                break;
            }
        }
    })
    .await
    .expect("the phone reconnects on renewed demand");
    assert_eq!(established_ssh(), 1);
    println!(
        "sshd connections 1 -> 0 after {:.2} s -> 1 on return",
        closed.as_secs_f64()
    );
    response(core.quiesce());
    response(core.quiesced().await);
}

#[test]
#[ignore = "runs 60-second samples against the seeded Docker fixture"]
fn docker_demand_records_live_rates_and_bounded_history_cost() {
    let runtime = Runtime::new().expect("create the Docker test runtime");
    runtime.block_on(measure_rates_and_history());
    measure_park_grace(&runtime);
}

async fn measure_rates_and_history() {
    let bytes = Arc::new(AtomicU64::new(0));
    let source = source(bytes.clone());
    let hub = LiveHub::default();
    let handle = source
        .clone()
        .start(SourceSink {
            live: hub.clone(),
            store: None,
        })
        .expect("start the counting remote source");
    wait_for(
        &hub,
        |event| matches!(event, BusMsg::Frame(frame) if frame.interval_ms == 5_000),
    )
    .await;
    let compact = bytes_per_sec(&hub, &bytes).await;
    handle.control().set_detail_interest(true);
    wait_for(
        &hub,
        |event| matches!(event, BusMsg::Frame(frame) if frame.interval_ms != 5_000),
    )
    .await;
    let full = bytes_per_sec(&hub, &bytes).await;
    handle.control().set_process_interest(Some(1_000));
    wait_for(&hub, |event| matches!(event, BusMsg::Processes(_))).await;
    let processes = bytes_per_sec(&hub, &bytes).await;
    println!(
        "channel payload: compact {compact:.2} B/s, full {full:.2} B/s, full plus CPU processes {processes:.2} B/s"
    );
    assert!(compact < full && full < processes);

    handle.control().set_process_interest(None);
    handle.control().set_detail_interest(false);
    wait_for(
        &hub,
        |event| matches!(event, BusMsg::Frame(frame) if frame.interval_ms == 5_000),
    )
    .await;
    measure_history(&source, &bytes).await;
    source.quiesce().await;
}
