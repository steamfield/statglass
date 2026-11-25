//! A key handed over through the controller's full SSH access, enforced by real sshd.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use statglass_proto::{
    Message, RemoteInterest,
    pairing::{BundleHost, PairReply, PairStart},
};
use statglass_remote::{
    AGENT_COMMAND_NOT_ALLOWED, AuthorizedKeys, ControlRequest, DeviceTag, EcdsaP256Public,
    Endpoint, PairCommands, PairingHost, PinnedHostKey, RemoteCommand, RemoteError, Route, Target,
    command::shell_quote,
    intents::{IntentLog, IntentOp, PendingIntent},
    ssh_config::{HandoverInput, handover_host},
};
use statglass_schema::HostId;
use statglass_session::{ForcedToken, codec};
use statglass_ssh::{RusshDialer, SoftwareSigner};
use uuid::Uuid;

const ALIAS: &str = "statglass-handover";
const AGENT: &str = "/usr/local/bin/statglass-agent";
const SOCKET: &str = "/home/statglass/run/handover.sock";
const USER: &str = "statglass";

fn fixture(name: &str) -> PathBuf {
    env::var_os(format!("STATGLASS_SSH_DOCKER_{name}"))
        .unwrap_or_else(|| panic!("make ssh-docker-test supplies {name}"))
        .into()
}

fn checked(command: &mut Command) -> Output {
    let result = command.output().expect("run Docker fixture command");
    assert!(
        result.status.success(),
        "{command:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    result
}

struct TestHost {
    container: String,
    files: tempfile::TempDir,
    server: PathBuf,
    full_key: PathBuf,
}

impl TestHost {
    fn new() -> Self {
        let fixture_config = fixture("SSH_CONFIG");
        let host = Self {
            container: format!("statglass-handover-{}", Uuid::new_v4()),
            files: tempfile::tempdir().expect("create fixture file directory"),
            server: fixture_config
                .parent()
                .expect("fixture directory")
                .join("server"),
            full_key: fixture("KEY").with_extension(""),
        };
        // This sibling of the shared fixture can restart without resetting authorized_keys.
        checked(Command::new("docker").args(["run", "--detach", "--name", &host.container, "--publish", "127.0.0.1::22"])
            .arg("--volume").arg(format!("{}:/fixture:ro", host.server.display()))
            .args(["statglass-ssh-docker", "sh", "-ec", r#"
                install -m 600 /fixture/host /etc/ssh/fixture_host_key
                install -d -o statglass -g statglass -m 700 /home/statglass/.ssh
                if [ ! -f /home/statglass/.ssh/authorized_keys ]; then
                    install -o statglass -g statglass -m 600 /fixture/authorized_keys /home/statglass/.ssh/authorized_keys
                fi
                install -m 755 /fixture/statglass-agent /usr/local/bin/statglass-agent
                if [ -f /fixture/statglass-remote-helper ]; then
                    install -m 755 /fixture/statglass-remote-helper /usr/local/bin/statglass-remote-helper
                fi
                install -d -o statglass -g statglass -m 700 /home/statglass/.local /home/statglass/.local/bin /home/statglass/.local/state
                ln -sf /usr/local/bin/statglass-agent /home/statglass/.local/bin/statglass-agent
                exec /usr/sbin/sshd -D -e -f /dev/null -h /etc/ssh/fixture_host_key -o UsePAM=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=no -o AllowUsers=statglass
            "#]));
        host
    }

    fn configure(&self, phone_key: &Path) {
        let address = checked(Command::new("docker").args(["port", &self.container, "22/tcp"]));
        let address = String::from_utf8(address.stdout).expect("read Docker's published address");
        let port = address
            .trim()
            .rsplit_once(':')
            .expect("address includes a port")
            .1;
        let public =
            fs::read_to_string(self.server.join("host.pub")).expect("read the fixture host key");
        let known_hosts = self.files.path().join("known_hosts");
        fs::write(&known_hosts, format!("[127.0.0.1]:{port} {public}"))
            .expect("pin the fixture host key");
        for (name, key) in [("mac", self.full_key.as_path()), ("phone", phone_key)] {
            fs::write(self.files.path().join(name), format!(
                "Host {ALIAS} 127.0.0.1\nHostName 127.0.0.1\nPort {port}\nUser {USER}\nIdentityFile \"{}\"\nUserKnownHostsFile \"{}\"\nGlobalKnownHostsFile none\nStrictHostKeyChecking yes\nIdentityAgent none\nIdentitiesOnly yes\nBatchMode yes\n",
                key.display(), known_hosts.display(),
            )).expect("write fixture SSH config");
        }
    }

    fn ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let result = self.ssh("mac", "true");
            if result.status.success() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "sshd never accepted full access: {result:?}"
            );
        }
    }

    fn ssh(&self, side: &str, command: &str) -> Output {
        Command::new("/usr/bin/ssh")
            .arg("-F")
            .arg(self.files.path().join(side))
            .args(["-T", "-oConnectTimeout=1", "--", ALIAS, command])
            .stdin(Stdio::null())
            .output()
            .expect("run SSH against the fixture")
    }

    fn start_agent(&self) -> HostId {
        checked(Command::new("docker").args([
            "exec",
            "--detach",
            "--user",
            USER,
            &self.container,
            AGENT,
            "run",
            "--socket",
            SOCKET,
        ]));
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let result = self.ssh("mac", &format!("{AGENT} status --json --socket {SOCKET}"));
            if result.status.success() {
                let value: serde_json::Value =
                    serde_json::from_slice(&result.stdout).expect("decode agent status");
                if value["running"] == true {
                    return serde_json::from_value(value["host_id"].clone())
                        .expect("decode the running host ID");
                }
            }
            assert!(
                Instant::now() < deadline,
                "agent never answered: {result:?}"
            );
        }
    }
}

impl Drop for TestHost {
    fn drop(&mut self) {
        let result = Command::new("docker")
            .args(["rm", "-f", &self.container])
            .output();
        if !result.is_ok_and(|output| output.status.success()) {
            eprintln!("could not remove handover fixture {}", self.container);
        }
    }
}

fn apply(fixture: &TestHost, log: &IntentLog, intent: PendingIntent) -> Output {
    let command = match intent.install {
        Some((key, name)) => format!(
            "{AGENT} authorize-key --key {} --name {} --socket {SOCKET}",
            shell_quote(&key.to_base64()),
            shell_quote(&name)
        ),
        None => format!("{AGENT} revoke-key --device {}", intent.device),
    };
    let output = fixture.ssh("mac", &command);
    if output.status.success() {
        assert_eq!(output.stdout, format!("{}\n", intent.device).as_bytes());
        log.mark_applied(intent.seq, 10)
            .expect("commit the successful outcome");
    } else {
        let reason = String::from_utf8_lossy(&output.stderr);
        log.mark_failed(intent.seq, reason.trim(), 10)
            .expect("commit the failed outcome");
    }
    output
}

fn resolved_endpoint(fixture: &TestHost, id: HostId) -> Endpoint {
    let bundle = handover_host(
        &HandoverInput {
            host_id: id,
            name: "Fixture Linux".into(),
            os: "linux".into(),
            lan: Some(ALIAS.into()),
            tailscale: None,
        },
        Some(&fixture.files.path().join("mac")),
    )
    .expect("resolve the fixture's SSH alias");
    let fingerprint = checked(
        Command::new("/usr/bin/ssh-keygen")
            .args(["-lf"])
            .arg(fixture.server.join("host.pub")),
    );
    assert_eq!(bundle.host_keys.len(), 1);
    assert_eq!(
        bundle.host_keys[0].sha256,
        String::from_utf8_lossy(&fingerprint.stdout)
            .split_ascii_whitespace()
            .nth(1)
            .expect("the fingerprint token")
    );
    Endpoint {
        targets: vec![Target {
            route: Route::Lan,
            host: bundle.targets[0].host.clone(),
        }],
        port: bundle.port,
        user: Some(bundle.user),
        host_keys: bundle
            .host_keys
            .into_iter()
            .map(|key| PinnedHostKey {
                algorithm: key.algorithm,
                sha256: key.sha256,
            })
            .collect(),
        command: RemoteCommand::Restricted {
            forced: ForcedToken::Serve,
        },
    }
}

#[tokio::test]
#[ignore = "requires the sshd image and agent from make ssh-docker-test"]
async fn handover_installs_a_restricted_key_and_replays_a_revoke_when_the_host_returns() {
    let fixture = TestHost::new();
    let phone_key = fixture.files.path().join("iphone");
    checked(
        Command::new("openssl")
            .args([
                "genpkey",
                "-algorithm",
                "EC",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
                "-pkeyopt",
                "ec_param_enc:named_curve",
                "-out",
            ])
            .arg(&phone_key),
    );
    let private = checked(
        Command::new("openssl")
            .args(["pkcs8", "-topk8", "-nocrypt", "-outform", "DER", "-in"])
            .arg(&phone_key),
    );
    let public = checked(
        Command::new("/usr/bin/ssh-keygen")
            .args(["-y", "-f"])
            .arg(&phone_key),
    );
    let line = String::from_utf8(public.stdout).unwrap();
    let key = EcdsaP256Public::from_authorized_key(line.trim_end()).unwrap();
    let tag = DeviceTag::from_key(&key);
    fixture.configure(&phone_key);
    fixture.ready();
    let id = fixture.start_agent();
    let endpoint = resolved_endpoint(&fixture, id);
    let dialer = RusshDialer::new(Arc::new(
        SoftwareSigner::from_pkcs8_der(&private.stdout).unwrap(),
    ));
    let controller = HostId(Uuid::new_v4());
    let path = fixture.files.path().join("device-intents.jsonl");
    let log = IntentLog::open(path.clone()).unwrap();
    let install = log
        .record(
            id,
            tag,
            IntentOp::Install {
                key: key.to_base64(),
                name: "Riley's iPhone".into(),
            },
            1,
        )
        .expect("record the install intent");

    assert!(matches!(
        statglass_session::connect(&dialer, &endpoint, controller, Some(id)).await,
        Err(RemoteError::Authentication(_))
    ));
    let applied = apply(&fixture, &log, log.pending().unwrap().pop().unwrap());
    assert!(applied.status.success(), "{applied:?}");
    assert!(log.pending().unwrap().is_empty());
    assert_wrong_pin_refused(&dialer, &endpoint, controller, id).await;
    assert_live(&dialer, &endpoint, controller, id).await;
    for operation in [
        format!("authorize-key --key {} --name Phone", key.to_base64()),
        format!("revoke-key --device {tag}"),
    ] {
        let output = fixture.ssh("phone", &operation);
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(
            output.stderr,
            format!("{AGENT_COMMAND_NOT_ALLOWED}\n").as_bytes()
        );
    }
    checked(Command::new("docker").args(["stop", "--time", "1", &fixture.container]));
    let revoke = log.record(id, tag, IntentOp::Revoke, 2).unwrap();
    assert!(revoke > install);
    let offline = apply(&fixture, &log, log.pending().unwrap().pop().unwrap());
    assert!(!offline.status.success());
    drop(log);

    let log = IntentLog::open(path).unwrap();
    log.mark_applied(install, 3).unwrap();
    let mut pending = log.pending().unwrap();
    assert_eq!(pending.len(), 1);
    let intent = pending.pop().unwrap();
    assert_eq!(intent.seq, revoke);
    assert_eq!(intent.attempts, 1);
    assert!(intent.last_error.is_some());
    assert!(intent.install.is_none());
    checked(Command::new("docker").args(["start", &fixture.container]));
    fixture.configure(&phone_key);
    fixture.ready();
    assert!(fixture.ssh("phone", "version").status.success());
    let applied = apply(&fixture, &log, intent);
    assert!(applied.status.success(), "{applied:?}");
    assert!(log.pending().unwrap().is_empty());
    assert_revoked(&fixture, tag);
}

async fn assert_wrong_pin_refused(
    dialer: &RusshDialer,
    endpoint: &Endpoint,
    controller: HostId,
    id: HostId,
) {
    let mut wrong_pin = endpoint.clone();
    wrong_pin.host_keys[0].sha256 = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into();
    assert!(matches!(
        statglass_session::connect(dialer, &wrong_pin, controller, Some(id)).await,
        Err(RemoteError::HostKey(_))
    ));
}

async fn assert_live(dialer: &RusshDialer, endpoint: &Endpoint, controller: HostId, id: HostId) {
    let mut session = statglass_session::connect(dialer, endpoint, controller, Some(id))
        .await
        .expect("connect the authorized phone");
    codec::write(
        &mut session.writer,
        &Message::Interest(RemoteInterest {
            detail: true,
            ..Default::default()
        }),
    )
    .await
    .expect("subscribe to live data");
    tokio::time::timeout(Duration::from_secs(15), async {
        while !matches!(
            codec::read(&mut session.reader)
                .await
                .expect("read a restricted session message"),
            Message::Live(_)
        ) {}
    })
    .await
    .expect("restricted session receives live metrics");
    session.close().await;
}

fn assert_revoked(fixture: &TestHost, tag: DeviceTag) {
    let rejected = fixture.ssh("phone", "version");
    assert_eq!(rejected.status.code(), Some(255));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("Permission denied"));
    let replay = fixture.ssh("mac", &format!("{AGENT} revoke-key --device {tag}"));
    assert!(replay.status.success(), "{replay:?}");
    assert_eq!(replay.stdout, format!("{tag}\n").as_bytes());
}

fn paired_line(directory: &Path, key: &EcdsaP256Public, name: &str) -> String {
    let path = directory.join("expected-authorized_keys");
    let stable_link = Path::new(
        "/home/statglass/Library/Application Support/com.tryopendata.statglass/bin/statglass-remote-helper",
    );
    let host = PairingHost::new(
        Arc::new(AuthorizedKeys::at(path.clone())),
        PairCommands::for_helper(stable_link).expect("the helper path is UTF-8"),
    );
    let now = statglass_engine::wall_ms();
    let payload = host
        .offer(
            BundleHost {
                host_id: HostId(Uuid::new_v4()),
                name: "Local".into(),
                os: "macos".into(),
                user: USER.into(),
                port: None,
                targets: vec![],
                host_keys: vec![],
            },
            Duration::ZERO,
            now,
        )
        .expect("offer pairing");
    let start = PairStart {
        nonce: payload.nonce.clone(),
        device_key: key.0.to_vec(),
        device_name: name.into(),
        model: "iPhone".into(),
    };
    assert_eq!(
        host.control_reply(
            ControlRequest::PairStart {
                start,
                attempt: [1; 16]
            },
            now
        )
        .pairing,
        Some(PairReply::Waiting)
    );
    assert!(matches!(
        host.approve(&payload.nonce, now),
        Ok(PairReply::Approved { .. })
    ));
    fs::read_to_string(path).expect("read the approved pairing line")
}

#[test]
#[ignore = "requires the disposable SSH account and helper from make ssh-docker-test"]
fn helper_cli_authorizes_the_same_line_as_pairing_and_revokes_idempotently() {
    let fixture = TestHost::new();
    fixture.configure(&fixture.full_key);
    fixture.ready();
    let run = |args: &[&str]| {
        checked(
            Command::new("docker")
                .args(["exec", "--user", USER, &fixture.container])
                .args(args),
        )
        .stdout
    };
    let keys = || run(&["/bin/cat", "/home/statglass/.ssh/authorized_keys"]);
    let original = keys();
    let encoded =
        "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=";
    let key = EcdsaP256Public::from_base64(encoded).unwrap();
    let tag = DeviceTag::from_key(&key);
    let name = "Fixture iPhone";
    let helper = "/usr/local/bin/statglass-remote-helper";
    assert_eq!(
        run(&[helper, "authorize-key", "--key", encoded, "--name", name]),
        format!("{tag}\n").as_bytes()
    );
    let expected = paired_line(fixture.files.path(), &key, name);
    assert_eq!(
        keys().strip_prefix(original.as_slice()),
        Some(expected.as_bytes())
    );
    for _ in 0..2 {
        assert_eq!(
            run(&[helper, "revoke-key", "--device", &tag.to_string()]),
            format!("{tag}\n").as_bytes()
        );
        assert_eq!(keys(), original);
    }
}
