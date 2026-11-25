//! Run through `make ssh-docker-test`, which provides the agent and sshd fixture.

mod support;

use serde_json::{Value, json};
use statglass_ipc::mobile::MobileConfig;
use statglass_mobile::{CoreEvents, MobileCore, NativeSigner, NativeSignerError};
use statglass_proto::pairing::parse_payload;
use statglass_ssh::{Signer, SoftwareSigner};
use std::{
    env, fs,
    process::Stdio,
    sync::Arc,
    task::{Context, Poll, Waker},
    time::Duration,
};
use support::DockerFixture;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdout, Command},
    runtime::Runtime,
    time::timeout,
};

struct SoftwareNativeKey(SoftwareSigner);

impl NativeSigner for SoftwareNativeKey {
    fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
        Ok(self.0.public_key().to_vec())
    }

    fn sign(&self, message: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
        let mut signing = self.0.sign(message);
        let Poll::Ready(result) = signing
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        else {
            panic!("the software key signs synchronously");
        };
        result.map_err(|error| NativeSignerError::Unexpected {
            message: error.to_string(),
        })
    }
}

struct PairProcess {
    child: Child,
    lines: Lines<BufReader<ChildStdout>>,
}

impl PairProcess {
    async fn offer(fixture: &DockerFixture, answer: &[u8]) -> (Self, String) {
        let container = env::var("STATGLASS_SSH_DOCKER_CONTAINER").expect("fixture container");
        let bin = env::var("STATGLASS_SSH_DOCKER_AGENT_BIN").expect("fixture agent path");
        let port = fixture.host.port.expect("published SSH port").to_string();
        let mut child = Command::new("docker")
            .args([
                "exec",
                "--interactive",
                "--user",
                &fixture.host.user,
                &container,
                "timeout",
                "--kill-after=5s",
                "75s",
                &bin,
                "pair",
                "--ttl",
                "60",
                "--target",
                "lan=127.0.0.1",
                "--port",
                &port,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("run the interactive agent");
        let output = child.stdout.take().expect("agent stdout");
        let mut offer = Self {
            child,
            lines: BufReader::new(output).lines(),
        };
        // The first line is the payload. Read through the terminal QR so the agent
        // can print its approval prompt after the phone sends PairStart.
        let text = timeout(Duration::from_secs(15), async {
            let text = offer
                .lines
                .next_line()
                .await
                .expect("read offer text")
                .expect("offer text");
            assert!(text.starts_with("SGP1:"));
            offer
                .read_until(|line| line.starts_with("Pairing code: "))
                .await;
            let mut stdin = offer.child.stdin.take().expect("agent stdin");
            stdin.write_all(answer).await.expect("send decision");
            text
        })
        .await
        .expect("receive the agent offer");
        (offer, text)
    }

    async fn read_until(&mut self, matches: impl Fn(&str) -> bool) {
        while let Some(line) = self.lines.next_line().await.expect("read agent output") {
            if matches(&line) {
                return;
            }
        }
        panic!("the agent exited before printing the expected pairing status");
    }

    async fn finish(mut self, result: &str) {
        timeout(Duration::from_secs(20), async {
            self.read_until(|line| line == result).await;
            assert!(
                self.child
                    .wait()
                    .await
                    .expect("collect the interactive agent")
                    .success()
            );
        })
        .await
        .expect("interactive agent exits after the decision");
    }
}

fn envelope(text: &str) -> Value {
    serde_json::from_str(text).expect("mobile core response")
}

fn data(text: &str) -> Value {
    let response = envelope(text);
    assert_eq!(response["status"], "ok", "{response}");
    response["data"].clone()
}

async fn call(core: &MobileCore, method: &str, args: Value) -> String {
    timeout(
        Duration::from_secs(30),
        core.call(method.into(), args.to_string()),
    )
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {method}"))
}

async fn pair(core: &MobileCore, text: String) -> String {
    call(
        core,
        "pair",
        json!({"text": text, "device_name": "Mobile core fixture", "model": "iPhone"}),
    )
    .await
}

fn start(core: &MobileCore, dir: &tempfile::TempDir) {
    let config = serde_json::to_string(&MobileConfig::default()).expect("phone config");
    assert_eq!(
        data(&core.start(dir.path().display().to_string(), config)),
        Value::Null
    );
}

#[test]
#[ignore = "requires the Linux agent and sshd fixture from make ssh-docker-test"]
fn docker_pair_approval_streams_and_persists_while_denial_keeps_the_saved_hosts() {
    let mut fixture = DockerFixture::new();
    let runtime = Runtime::new().expect("test runtime");
    let signer = Arc::new(SoftwareNativeKey(SoftwareSigner::generate()));
    assert_ne!(signer.0.public_key(), fixture.key.public_key());
    let core = MobileCore::new(signer.clone(), fixture.events.clone());
    start(&core, &fixture.dir);

    let (approved, text) = runtime.block_on(PairProcess::offer(&fixture, b"y\n"));
    let host_id = fixture.host.id;
    let payload = parse_payload(&text).expect("decode the agent's offer");
    assert_eq!(payload.host.host_id, host_id);
    assert_eq!(payload.host.port, fixture.host.port);
    assert_eq!(json!(payload.host.targets), json!(fixture.host.targets));
    assert_eq!(json!(payload.host.host_keys), json!(fixture.host.host_keys));
    runtime.block_on(async {
        let paired = data(&pair(&core, text).await);
        assert_eq!(
            paired,
            json!({ "id": host_id, "name": payload.host.name, "offered": [], "unavailable": [] })
        );
        let demand = json!({ "demand": [{ "host": host_id, "level": "full" }] });
        assert!(data(&call(&core, "set_demand", demand).await).is_null());
        let stream = 81;
        let request = json!({"host": host_id, "stream": stream});
        assert_eq!(
            data(&call(&core, "subscribe_live", request).await)["stream"],
            stream
        );
        fixture.expect_cpu(stream).await;
        assert!(data(&core.quiesce()).is_null());
        assert!(data(&core.quiesced().await).is_null());
    });
    runtime.block_on(approved.finish("Pairing approved"));
    drop(core);

    let hosts_file = fixture.dir.path().join("hosts.json");
    let saved = fs::read(&hosts_file).expect("approval saved the host");
    let restored = MobileCore::new(signer, fixture.events.clone());
    start(&restored, &fixture.dir);
    let (denied, text) = runtime.block_on(PairProcess::offer(&fixture, b"n\n"));
    runtime.block_on(async {
        let listed = data(&call(&restored, "list_hosts", Value::Null).await);
        let [host] = listed.as_array().expect("host list").as_slice() else {
            panic!("expected one restored host, got {listed}");
        };
        assert_eq!(host["id"], json!(host_id));
        let refused = envelope(&pair(&restored, text).await);
        assert_eq!(refused["status"], "error", "{refused}");
        assert_eq!(refused["error"]["kind"], "pairing", "{refused}");
        assert_eq!(refused["error"]["reason"], "denied", "{refused}");
        assert_eq!(
            data(&call(&restored, "list_hosts", Value::Null).await),
            listed
        );
    });
    runtime.block_on(denied.finish("Pairing denied"));
    assert_eq!(fs::read(hosts_file).expect("read saved hosts"), saved);
}
