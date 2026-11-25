//! Restricted sessions and real authorized_keys enforcement in make ssh-docker-test.
use statglass_proto::{Answer, ErrorCode, Message, Query, RemoteInterest, SyncRequest};
use statglass_remote::{
    AuthorizedKeys, DeviceKeys, DeviceTag, EcdsaP256Public, Endpoint, OpenSshDialer, RemoteCommand,
    Route, SshSession, Target,
};
use statglass_schema::{HostId, Tier, usage::UsageKey};
use statglass_session::{ForcedToken, codec};
use std::{
    env, fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
use uuid::Uuid;

fn fixture(name: &str) -> String {
    env::var(format!("STATGLASS_SSH_DOCKER_{name}"))
        .unwrap_or_else(|error| panic!("make ssh-docker-test supplies {name}: {error}"))
}

fn restricted_key() -> PathBuf {
    PathBuf::from(fixture("RESTRICTED_KEY")).with_extension("")
}

fn checked(command: &mut Command) -> Output {
    let result = command.output().expect("launch fixture command");
    assert!(
        result.status.success(),
        "{command:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    result
}

#[tokio::test]
#[ignore = "requires the sshd and agent from make ssh-docker-test"]
async fn restricted_key_streams_and_syncs_but_refuses_queries_and_other_commands() {
    let config = fs::read_to_string(fixture("SSH_CONFIG")).unwrap();
    let full = PathBuf::from(fixture("KEY")).with_extension("");
    let config = config.replace(full.to_str().unwrap(), restricted_key().to_str().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ssh-config");
    fs::write(&path, config).unwrap();
    let transport = OpenSshDialer::with_config_file(&path);
    let host = HostId(Uuid::parse_str(&fixture("HOST_ID")).unwrap());
    let endpoint = Endpoint {
        targets: vec![Target {
            route: Route::Lan,
            host: "statglass-docker".into(),
        }],
        port: None,
        user: None,
        host_keys: vec![],
        command: RemoteCommand::Restricted {
            forced: ForcedToken::Serve,
        },
    };
    let mut session =
        statglass_session::connect(&transport, &endpoint, HostId(Uuid::new_v4()), Some(host))
            .await
            .unwrap();
    assert_eq!(session.hello.host.id, host);
    tokio::time::timeout(Duration::from_secs(35), assert_live_and_sync(&mut session))
        .await
        .expect("receive live and a closed ten-second history bucket");
    tokio::time::timeout(
        Duration::from_secs(15),
        assert_queries_refused(&mut session),
    )
    .await
    .expect("receive query refusals");
    session.close().await;
    let denied = Command::new("ssh")
        .arg("-F")
        .arg(&path)
        .args(["statglass-docker", "serve --stdio"])
        .output()
        .unwrap();
    assert_eq!(denied.status.code(), Some(2));
    assert!(denied.stdout.is_empty());
    assert_eq!(denied.stderr, b"statglass-agent: command not allowed\n");

    let paired = checked(Command::new("docker").args([
        "exec",
        "--user",
        "statglass",
        "--env",
        "HOME=/home/statglass",
        &fixture("CONTAINER"),
        &fixture("AGENT_BIN"),
        "devices",
    ]));
    let list = String::from_utf8(paired.stdout).unwrap();
    let fields: Vec<_> = list.trim_end().split('\t').collect();
    assert_eq!(fields.len(), 4, "{list:?}");
    assert_eq!(&fields[..2], ["0BADC0", "docker-fixture"]);
    assert!(fields[2].starts_with("SHA256:"));
    assert!(fields[3].parse::<i64>().unwrap() > 0);
}

async fn read_message(session: &mut SshSession) -> Message {
    codec::read(&mut session.reader)
        .await
        .expect("read a framed agent message")
}

async fn assert_live_and_sync(session: &mut SshSession) {
    codec::write(
        &mut session.writer,
        &Message::Interest(RemoteInterest {
            detail: true,
            ..Default::default()
        }),
    )
    .await
    .expect("subscribe to restricted live metrics");
    let mut layout = None;
    loop {
        match read_message(session).await {
            Message::LayoutDef(value) => layout = Some(value.layout_no),
            Message::Live(frame) => {
                assert_eq!(layout, Some(frame.layout_no));
                break;
            }
            _ => {}
        }
    }
    loop {
        codec::write(
            &mut session.writer,
            &Message::SyncRequest(SyncRequest {
                tier: Tier::S10,
                after: None,
                max_rows: 1,
                from_ms: None,
                max_bytes: None,
            }),
        )
        .await
        .expect("request restricted history");
        loop {
            match read_message(session).await {
                Message::SyncPage(page) => {
                    assert_eq!(page.epoch, session.hello.db_instance_uuid);
                    assert_eq!(page.tier, Tier::S10);
                    if !page.rows.is_empty() {
                        return;
                    }
                    break;
                }
                Message::Error { code, message } => panic!("{code:?}: {message}"),
                _ => {}
            }
        }
        // A cold fixture may have no closed bucket yet.
        while !matches!(read_message(session).await, Message::Live(_)) {}
    }
}

async fn assert_queries_refused(session: &mut SshSession) {
    let queries = [
        Query::UsageByApp {
            from_ms: 0,
            to_ms: 1,
            by: UsageKey::Cpu,
            limit: 1,
        },
        Query::SpaceStart {
            volume: "/".into(),
            include: vec![],
        },
        Query::SpaceCancel,
        Query::SpaceClear,
        Query::Unknown,
    ];
    for (id, query) in (0..).zip(queries) {
        codec::write(&mut session.writer, &Message::Request { id, query })
            .await
            .expect("send a query to the restricted session");
        loop {
            if let Message::Reply {
                id: received,
                answer,
            } = read_message(session).await
            {
                assert_eq!(received, id);
                assert!(
                    matches!(
                        answer,
                        Answer::Error {
                            code: ErrorCode::Unsupported,
                            ..
                        }
                    ),
                    "{answer:?}"
                );
                break;
            }
        }
    }
}

struct Sshd {
    container: String,
    port: String,
    known_hosts: PathBuf,
}

impl Sshd {
    fn start(fixture_dir: &Path, keys_dir: &Path) -> Self {
        let mut sshd = Self {
            container: format!("statglass-keys-test-{}", Uuid::new_v4()),
            port: String::new(),
            known_hosts: keys_dir.join("known_hosts"),
        };
        checked(
            Command::new("docker")
                .args([
                    "run",
                    "--detach",
                    "--rm",
                    "--name",
                    &sshd.container,
                    "--publish",
                    "127.0.0.1::22",
                ])
                .arg("--volume")
                .arg(format!("{}:/fixture:ro", fixture_dir.display()))
                .arg("--volume")
                .arg(format!("{}:/keys:ro", keys_dir.display()))
                .args([
                    "statglass-ssh-docker",
                    "sh",
                    "-ec",
                    r#"
                install -m 600 /fixture/host /etc/ssh/fixture_host_key
                install -m 755 /fixture/statglass-agent /usr/local/bin/statglass-agent
                install -d -o statglass -g statglass -m 700 /home/statglass/.ssh
                cp --preserve=mode /keys/managed-keys /home/statglass/.ssh/managed-keys
                chown statglass:statglass /home/statglass/.ssh/managed-keys
                ln -s managed-keys /home/statglass/.ssh/authorized_keys
                exec /usr/sbin/sshd -D -e -f /dev/null -h /etc/ssh/fixture_host_key \
                    -o UsePAM=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
                    -o PermitRootLogin=no -o AllowUsers=statglass
            "#,
                ]),
        );
        let port = checked(Command::new("docker").args(["port", &sshd.container, "22/tcp"]));
        sshd.port = String::from_utf8(port.stdout)
            .expect("docker port prints text")
            .trim()
            .rsplit_once(':')
            .expect("docker port prints an address and port")
            .1
            .into();
        let pubkey = fs::read_to_string(fixture_dir.join("host.pub"))
            .expect("read the pinned fixture host key");
        fs::write(
            &sshd.known_hosts,
            format!("[127.0.0.1]:{} {pubkey}", sshd.port),
        )
        .expect("write the fixture's known_hosts file");
        sshd
    }

    fn ssh(&self, key: &Path, token: &str) -> Output {
        Command::new("ssh")
            .args([
                "-F",
                "/dev/null",
                "-o",
                "ConnectTimeout=1",
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "IdentityAgent=none",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "GlobalKnownHostsFile=/dev/null",
            ])
            .arg("-o")
            .arg(format!("UserKnownHostsFile={}", self.known_hosts.display()))
            .args(["-p", &self.port, "-i"])
            .arg(key)
            .args(["statglass@127.0.0.1", token])
            .output()
            .expect("run ssh against the fixture")
    }

    fn assert_denied(&self, key: &Path, token: &str) {
        let result = self.ssh(key, token);
        assert_eq!(result.status.code(), Some(255));
        assert!(result.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&result.stderr).contains("Permission denied (publickey)"),
            "{result:?}"
        );
    }
}

impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "-f", &self.container])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn public_key(pem: &Path) -> EcdsaP256Public {
    let der = checked(
        Command::new("openssl")
            .args(["pkey", "-in"])
            .arg(pem)
            .args(["-pubout", "-outform", "DER"]),
    )
    .stdout;
    EcdsaP256Public(
        der[der.len() - 65..]
            .try_into()
            .expect("SEC1 point is 65 bytes"),
    )
}

async fn assert_seen_with_a_custom_data_dir(
    sshd: &Sshd,
    device_key: &Path,
    agent: &str,
    socket: &str,
    tag: DeviceTag,
) {
    checked(Command::new("docker").args([
        "exec",
        "--detach",
        "--user",
        "statglass",
        "--env",
        "HOME=/home/statglass",
        &sshd.container,
        agent,
        "run",
        "--socket",
        socket,
        "--data-dir",
        "/home/statglass/custom-state",
    ]));
    let dir = tempfile::tempdir().expect("create restricted SSH config directory");
    let path = dir.path().join("ssh-config");
    fs::write(&path, format!(
        "Host statglass-docker\n    HostName 127.0.0.1\n    Port {}\n    User statglass\n    IdentityFile \"{}\"\n    UserKnownHostsFile \"{}\"\n    GlobalKnownHostsFile /dev/null\n    StrictHostKeyChecking yes\n    IdentityAgent none\n    IdentitiesOnly yes\n    BatchMode yes\n",
        sshd.port, device_key.display(), sshd.known_hosts.display(),
    )).expect("write restricted SSH config");
    let dialer = OpenSshDialer::with_config_file(path);
    let endpoint = Endpoint {
        targets: vec![Target {
            route: Route::Lan,
            host: "statglass-docker".into(),
        }],
        port: None,
        user: None,
        host_keys: vec![],
        command: RemoteCommand::Restricted {
            forced: ForcedToken::Serve,
        },
    };
    let local = HostId(Uuid::new_v4());
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut session = loop {
            match statglass_session::connect(&dialer, &endpoint, local, None).await {
                Ok(session) => break session,
                Err(statglass_remote::RemoteError::AgentNotRunning(_)) => {}
                Err(error) => panic!("unexpected restricted handshake failure: {error}"),
            }
        };
        assert!(matches!(
            read_message(&mut session).await,
            Message::SourceStatus(_)
        ));
        session.close().await;
    })
    .await
    .expect("receive a status from the daemon with custom data");
    let paired = checked(Command::new("docker").args([
        "exec",
        "--user",
        "statglass",
        "--env",
        "HOME=/home/statglass",
        &sshd.container,
        agent,
        "devices",
    ]));
    let list = String::from_utf8(paired.stdout).expect("devices print text");
    let fields: Vec<_> = list.trim_end().split('\t').collect();
    assert_eq!(fields.len(), 4, "{list:?}");
    assert_eq!(fields[0], tag.to_string());
    assert!(
        fields[3].parse::<i64>().is_ok_and(|time| time > 0),
        "{list:?}"
    );
}

#[tokio::test]
#[ignore = "requires the OpenSSH Docker image and fixture keys from make ssh-docker-test"]
async fn sshd_enforces_expiry_and_a_device_key_can_be_added_and_revoked_through_a_symlink() {
    let config = PathBuf::from(fixture("SSH_CONFIG"));
    let fixture_dir = config.parent().unwrap().join("server");
    let device_key = restricted_key();
    let pairing_key = PathBuf::from(fixture("KEY")).with_extension("");
    let keys_dir = tempfile::tempdir().unwrap();
    let target = keys_dir.path().join("managed-keys");
    let path = keys_dir.path().join("authorized_keys");
    symlink("managed-keys", &path).unwrap();
    let keys = AuthorizedKeys::at(path.clone());
    let device = public_key(&device_key);
    let tag = DeviceTag::from_key(&device);
    let agent = fixture("AGENT_BIN");
    let socket = fixture("SOCKET");
    let nonce = "123456789012345678901234567890ab";
    let pair_command = format!("/bin/echo pair --nonce {nonce}");
    keys.add_device(
        &device,
        "Docker iPhone",
        &format!("'{agent}' restricted --device {tag} --socket '{socket}'"),
    )
    .unwrap();
    keys.add_pairing(
        &public_key(&pairing_key),
        nonce,
        1_577_836_800_000,
        &pair_command,
    )
    .unwrap();
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());

    let sshd = Sshd::start(&fixture_dir, keys_dir.path());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let result = sshd.ssh(&device_key, "version");
        if result.status.success() {
            assert!(
                serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()["version"]
                    .is_string()
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "device key must authenticate: {result:?}"
        );
    }
    let stopped = sshd.ssh(&device_key, "serve");
    assert_eq!(stopped.status.code(), Some(3));
    assert_eq!(
        stopped.stderr,
        format!("{}\n", statglass_remote::AGENT_NOT_RUNNING).as_bytes()
    );
    sshd.assert_denied(&pairing_key, "pair");

    // Change only the expiry and prove the same key and command otherwise work.
    keys.add_pairing(
        &public_key(&pairing_key),
        nonce,
        4_070_908_800_000,
        &pair_command,
    )
    .unwrap();
    checked(Command::new("docker").args(["exec", &sshd.container, "sh", "-ec",
        "install -o statglass -g statglass -m 600 /keys/managed-keys /home/statglass/.ssh/managed-keys"]));
    let pair = sshd.ssh(&pairing_key, "pair");
    assert!(pair.status.success(), "{pair:?}");
    assert_eq!(pair.stdout, format!("pair --nonce {nonce}\n").as_bytes());

    assert_seen_with_a_custom_data_dir(&sshd, &device_key, &agent, &socket, tag).await;
    checked(Command::new("docker").args([
        "exec",
        "--user",
        "statglass",
        "--env",
        "HOME=/home/statglass",
        &sshd.container,
        &agent,
        "devices",
        "revoke",
        &tag.to_string(),
    ]));
    sshd.assert_denied(&device_key, "version");
    let state = checked(Command::new("docker").args([
        "exec",
        &sshd.container,
        "sh",
        "-ec",
        "cd /home/statglass/.ssh; readlink authorized_keys; stat -c %a . managed-keys",
    ]));
    assert_eq!(state.stdout, b"managed-keys\n700\n600\n");
    assert!(sshd.ssh(&pairing_key, "pair").status.success());
}
