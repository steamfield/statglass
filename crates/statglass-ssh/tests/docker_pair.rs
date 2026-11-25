#![cfg(feature = "software-signer")]
//! Run through `make ssh-docker-test`, which starts the agent and sshd fixture.

use p256::ecdsa::SigningKey;
use p256::pkcs8::EncodePrivateKey;
use statglass_proto::pairing::{
    BundleHost, BundleRoute, BundleTarget, PairReply, PairingPayload, decode_payload,
};
use statglass_schema::HostId;
use statglass_session::{
    Dialer, Endpoint, ForcedToken, RemoteCommand, RemoteError,
    conformance::{self, ConformanceHost},
    pair,
    pairing::{PairingRefusal, endpoint_from_host},
};
use statglass_ssh::{RusshDialer, Signer, SoftwareSigner};
use std::{env, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdout, Command},
    time::timeout,
};

const NAME: &str = "Pairing test phone";
const MODEL: &str = "iPhone 17";

fn env(name: &str) -> String {
    env::var(format!("STATGLASS_SSH_DOCKER_{name}")).unwrap_or_else(|err| {
        panic!("STATGLASS_SSH_DOCKER_{name}: {err}. Run make ssh-docker-test")
    })
}

fn docker(user: &str) -> Command {
    let mut command = Command::new("docker");
    command.args([
        "exec",
        "--interactive",
        "--user",
        user,
        "--env",
        &format!("USER={user}"),
        &env("CONTAINER"),
    ]);
    command.kill_on_drop(true);
    command
}

async fn exec(user: &str, args: &[&str]) {
    let result = timeout(Duration::from_secs(10), docker(user).args(args).output())
        .await
        .expect("Docker fixture command deadline")
        .expect("run Docker fixture command");
    assert!(
        result.status.success(),
        "Docker fixture command: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

async fn prepare_fixture() {
    // The primary harness supplies sshd with a private key at a non-default path.
    // Give the agent its public half at the same path a regular install uses.
    exec(
        "root",
        &[
            "sh",
            "-ec",
            "ssh-keygen -y -f /etc/ssh/fixture_host_key > /etc/ssh/ssh_host_ed25519_key.pub",
        ],
    )
    .await;
    // The harness starts the daemon at a custom path. Pairing uses the agent's usual
    // user socket, so route that socket to the same daemon without starting a second.
    exec(
        &env("USER"),
        &[
            "sh",
            "-ec",
            "mkdir -p \"$HOME/.local/state/statglass-agent\" \"$HOME/.local/bin\"; ln -sfn \"$1\" \"$HOME/.local/state/statglass-agent/metrics.sock\"; ln -sfn \"$2\" \"$HOME/.local/bin/statglass-agent\"",
            "sh",
            &env("SOCKET"),
            &env("AGENT_BIN"),
        ],
    ).await;
}

struct PairProcess {
    child: Child,
    lines: Lines<BufReader<ChildStdout>>,
    user: String,
    pid: Option<u32>,
}

impl Drop for PairProcess {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            // Closing docker exec's local pipe does not send a signal in the container.
            // The enclosing harness also removes the disposable container on test exit.
            let _ = docker(&self.user).kill_on_drop(false)
                .args(["sh", "-c", "test \"$(basename \"$(readlink \"/proc/$1/exe\")\")\" != statglass-agent || kill -INT \"$1\"", "sh", &pid.to_string()])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        }
    }
}

impl PairProcess {
    fn start(user: &str) -> Self {
        let mut child = docker(user)
            .args([
                "sh",
                "-ec",
                "printf '%s\\n' \"$$\"; exec \"$@\"",
                "sh",
                &env("AGENT_BIN"),
                "pair",
                "--ttl",
                "60",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start the interactive agent in the background");
        let stdout = child.stdout.take().expect("piped pairing stdout");
        Self {
            child,
            lines: BufReader::new(stdout).lines(),
            user: user.into(),
            pid: None,
        }
    }

    async fn finish(&mut self) {
        drop(self.child.stdin.take());
        let status = timeout(Duration::from_secs(15), self.child.wait())
            .await
            .expect("interactive agent exits before its deadline")
            .expect("collect the interactive agent's exit status");
        self.pid = None;
        assert!(status.success(), "interactive agent cleans up and exits");
    }

    async fn decide(&mut self, code: &str, approve: Option<bool>) {
        let prompt = self
            .lines
            .next_line()
            .await
            .expect("read the approval prompt from stdout")
            .expect("wait for host approval prompt");
        assert_eq!(
            prompt,
            format!("Approve {NAME} ({MODEL}), code {code}? [y/N]")
        );
        if let Some(approve) = approve {
            self.child
                .stdin
                .as_mut()
                .expect("piped approval stdin")
                .write_all(if approve { b"y\n" } else { b"n\n" })
                .await
                .expect("send the terminal decision");
        } else {
            drop(self.child.stdin.take());
        }
    }

    async fn offer(&mut self) -> (u32, PairingPayload) {
        timeout(Duration::from_secs(10), async {
            let pid = self
                .lines
                .next_line()
                .await
                .expect("read the process ID")
                .expect("interactive process should print its PID")
                .parse()
                .expect("numeric process ID");
            self.pid = Some(pid);
            (pid, payload(&mut self.lines).await)
        })
        .await
        .expect("wait for pairing QR")
    }
}

async fn payload(lines: &mut Lines<BufReader<ChildStdout>>) -> PairingPayload {
    // Avoid echoing the one-time scalar or QR on a failure.
    let text = lines
        .next_line()
        .await
        .expect("read the pairing payload from stdout")
        .expect("interactive agent should print a payload");
    let payload = decode_payload(&text, statglass_engine::wall_ms())
        .expect("decode the interactive agent's pairing payload");
    let code_line = format!("Pairing code: {}", payload.code);
    let mut qr_seen = false;
    loop {
        let line = lines
            .next_line()
            .await
            .expect("read the terminal QR from stdout")
            .expect("interactive agent should print a code");
        if line == code_line {
            break;
        }
        qr_seen |= line.contains(['█', '▀', '▄']);
    }
    assert!(qr_seen, "interactive agent should print a Unicode QR");
    payload
}

async fn announce_socket(nonce: &str) {
    exec(
        &env("USER"),
        &[
            "sh",
            "-ec",
            "p=${XDG_RUNTIME_DIR:-\"$HOME/.local/state\"}/statglass; test \"$(stat -c %a \"$p\")\" = 700; test \"$(stat -c %a \"$p/pair-$1.sock\")\" = 600",
            "sh",
            nonce,
        ],
    ).await;
}

async fn run_pairing(answer: Option<bool>) {
    let approve = answer == Some(true);
    let user = env("USER");
    let mut process = PairProcess::start(&user);
    let (_, mut payload) = process.offer().await;
    announce_socket(&payload.nonce).await;
    let host_id = HostId(env("HOST_ID").parse().expect("agent's host UUID"));
    assert_eq!(payload.host.host_id, host_id);
    assert_eq!(payload.host.user, user);
    assert!(
        payload
            .host
            .host_keys
            .iter()
            .any(|key| format!("{} {}", key.algorithm, key.sha256) == env("HOST_KEY"))
    );
    // The Docker bridge address in the QR is reachable inside the VM only. Keep
    // the QR's SSH pins, user and identity, and dial the published port from here.
    let forwarded = BundleTarget {
        route: BundleRoute::Lan,
        host: env("HOST"),
    };
    let port = env("PORT").parse().expect("published SSH port");
    payload.host.targets = vec![forwarded.clone()];
    payload.host.port = Some(port);
    let scalar = SigningKey::from_slice(&payload.pairing_key)
        .expect("parse the QR's P-256 scalar")
        .to_pkcs8_der()
        .expect("prepare the pairing key for the software signer");
    let pairing_signer = SoftwareSigner::from_pkcs8_der(scalar.as_bytes())
        .expect("load the one-time pairing signer");
    let pairing_dialer = RusshDialer::new(Arc::new(pairing_signer));
    let device = Arc::new(SoftwareSigner::generate());
    let local = HostId(
        "00000000-0000-0000-0000-000000000057"
            .parse()
            .expect("fixed local UUID"),
    );
    let result = timeout(Duration::from_secs(20), async {
        let exchange = pair(
            &pairing_dialer,
            &payload,
            device.public_key(),
            NAME,
            MODEL,
            local,
        );
        tokio::pin!(exchange);
        tokio::select! {
            early = &mut exchange => panic!("pairing finished before the host decision: {early:?}"),
            () = process.decide(&payload.code, answer) => {},
        }
        exchange.await
    })
    .await
    .expect("the phone and host complete the pairing exchange");
    let final_line = process
        .lines
        .next_line()
        .await
        .expect("read the decision from stdout")
        .expect("interactive agent reports a decision");
    assert_eq!(
        final_line,
        if approve {
            "Pairing approved"
        } else {
            "Pairing denied"
        }
    );

    if approve {
        let (mut endpoint, reply) =
            result.expect("the approved pairing returns a restricted endpoint");
        assert!(matches!(reply, PairReply::Approved { .. }));
        endpoint.targets[0].host = forwarded.host;
        endpoint.port = Some(port);
        stream_from_approved_device(device, endpoint, host_id).await;
        assert_authentication_rejected(&pairing_dialer, &payload.host, ForcedToken::Pair).await;
    } else {
        assert!(
            matches!(result, Err(RemoteError::Pairing(PairingRefusal::Denied))),
            "{result:?}"
        );
        let device_dialer = RusshDialer::new(device);
        assert_authentication_rejected(&device_dialer, &payload.host, ForcedToken::Serve).await;
    }

    process.finish().await;
    assert_offer_removed(&user, &payload.nonce).await;
}

async fn assert_offer_removed(user: &str, nonce: &str) {
    exec(
        user,
        &[
            "sh",
            "-ec",
            "p=${XDG_RUNTIME_DIR:-\"$HOME/.local/state\"}/statglass; test ! -e \"$p/pair-$1.sock\"; ! grep -q \"statglass-pairing:$1\" \"$HOME/.ssh/authorized_keys\"",
            "sh",
            nonce,
        ],
    ).await;
}

async fn cancel_with_ctrl_c() {
    let user = env("USER");
    let mut process = PairProcess::start(&user);
    let (pid, offer) = process.offer().await;
    announce_socket(&offer.nonce).await;
    exec(
        &user,
        &["sh", "-ec", "kill -INT \"$1\"", "sh", &pid.to_string()],
    )
    .await;
    process.finish().await;
    assert_offer_removed(&user, &offer.nonce).await;
}

async fn stream_from_approved_device(
    device: Arc<SoftwareSigner>,
    endpoint: Endpoint,
    host_id: HostId,
) {
    assert_eq!(
        endpoint.command,
        RemoteCommand::Restricted {
            forced: ForcedToken::Serve
        }
    );
    let host = ConformanceHost {
        stopped: endpoint.clone(),
        endpoint,
        host_id,
    };
    conformance::live_session(&RusshDialer::new(device), &host).await;
}

async fn assert_authentication_rejected(
    dialer: &RusshDialer,
    host: &BundleHost,
    forced: ForcedToken,
) {
    let endpoint = endpoint_from_host(host, RemoteCommand::Restricted { forced })
        .expect("fixture SSH endpoint");
    assert!(matches!(
        dialer.dial(&endpoint, &endpoint.targets[0]).await,
        Err(RemoteError::Authentication(_))
    ));
}

#[tokio::test]
#[ignore = "requires the Linux agent and sshd fixture from make ssh-docker-test"]
async fn pairing_over_sshd_requires_approval_and_only_the_approved_device_can_stream() {
    timeout(Duration::from_secs(100), async {
        prepare_fixture().await;
        run_pairing(Some(true)).await;
        run_pairing(Some(false)).await;
        run_pairing(None).await;
        cancel_with_ctrl_c().await;
    })
    .await
    .expect("execute both pairing paths against the Docker fixture");
}
