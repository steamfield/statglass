use super::*;
use statglass_session::{PinnedHostKey, STDERR_TAIL_BYTES};
use std::{
    ffi::OsString, fs, os::unix::fs::PermissionsExt, pin::pin, process::Command as SystemCommand,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    time::{sleep, timeout},
};

const WAIT: Duration = Duration::from_secs(5);
const LOCAL: HostId = HostId(uuid::Uuid::from_u128(1));

fn config() -> EndpointConfig {
    EndpointConfig {
        lan: Some("studio.local".into()),
        tailscale: Some("studio.tailnet.ts.net".into()),
        command: RemoteCommand::default(),
    }
}

fn endpoint() -> Endpoint {
    EndpointConfig {
        tailscale: None,
        ..config()
    }
    .endpoint()
}

#[test]
fn endpoint_config_maps_aliases_in_preference_order() {
    let config = config();
    let endpoint = config.endpoint();
    assert_eq!(endpoint.command, config.command);
    assert_eq!(endpoint.port, None);
    assert_eq!(endpoint.user, None);
    assert!(endpoint.host_keys.is_empty());
    assert_eq!(
        endpoint.targets,
        [
            Target {
                route: Route::Lan,
                host: "studio.local".into()
            },
            Target {
                route: Route::Tailscale,
                host: "studio.tailnet.ts.net".into()
            },
        ]
    );
}

fn args(command: &Command) -> Vec<OsString> {
    command.as_std().get_args().map(OsString::from).collect()
}

#[test]
fn ssh_preserves_hardening_and_inserts_only_configured_overrides() {
    let mut endpoint = endpoint();
    let target = endpoint.targets[0].clone();
    let hardening = [
        "-T",
        "-oBatchMode=yes",
        "-oStrictHostKeyChecking=yes",
        "-oConnectTimeout=5",
        "-oConnectionAttempts=1",
        "-oServerAliveInterval=15",
        "-oServerAliveCountMax=3",
        "-oControlMaster=no",
        "-oControlPath=none",
        "-oClearAllForwardings=yes",
        "-oForwardAgent=no",
        "-oForwardX11=no",
        "-oPermitLocalCommand=no",
        "-oRequestTTY=no",
    ];
    let prefix: Vec<_> = hardening.into_iter().map(OsString::from).collect();
    let remote = endpoint.command.serve_command().unwrap();
    let suffix = ["--", &target.host, &remote].map(OsString::from);
    let default = OpenSshDialer::default()
        .command(&endpoint, &target)
        .unwrap();
    assert_eq!(default.as_std().get_program(), "/usr/bin/ssh");
    assert_eq!(args(&default), [prefix.as_slice(), &suffix].concat());
    assert_eq!(
        args(&ssh_command(&target.host).unwrap()),
        [prefix.as_slice(), &suffix[..2]].concat()
    );

    endpoint.port = Some(2222);
    endpoint.user = Some("statglass".into());
    endpoint.host_keys.push(PinnedHostKey {
        algorithm: "ssh-ed25519".into(),
        sha256: "SHA256:unused".into(),
    });
    let overrides = ["-oPort=2222", "-oUser=statglass"].map(OsString::from);
    let configured = OpenSshDialer::with_config_file("/config dir/ssh config")
        .command(&endpoint, &target)
        .unwrap();
    let file = ["-F", "/config dir/ssh config"].map(OsString::from);
    assert_eq!(
        args(&configured),
        [prefix.as_slice(), &overrides, &file, &suffix].concat()
    );
    let default = OpenSshDialer::default()
        .command(&endpoint, &target)
        .unwrap();
    assert_eq!(
        args(&default),
        [prefix.as_slice(), &overrides, &suffix].concat()
    );
}

fn fake_ssh(script: &str) -> (tempfile::TempDir, OpenSshDialer) {
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("ssh");
    fs::write(&program, format!("#!/bin/sh\n{script}")).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let dialer = OpenSshDialer::with_program(program);
    (dir, dialer)
}

fn exists(pid: u32) -> bool {
    SystemCommand::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

struct TestChild(u32);

impl Drop for TestChild {
    fn drop(&mut self) {
        if exists(self.0) {
            let _ = SystemCommand::new("/bin/kill")
                .args(["-KILL", &self.0.to_string()])
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[tokio::test]
async fn cancelling_a_dial_waiting_for_hello_kills_ssh() {
    let (dir, dialer) = fake_ssh(
        r#"
printf '%s\n' "$$" > "$0.pid"
exec /bin/sleep 30
"#,
    );
    let endpoint = endpoint();
    let path = dir.path().join("ssh.pid");
    let pid = {
        let mut dial = pin!(statglass_session::connect(&dialer, &endpoint, LOCAL, None));
        tokio::select! {
            result = &mut dial => panic!("dial finished before cancellation: {:?}", result.err()),
            pid = timeout(WAIT, async {
                loop {
                    if let Ok(pid) = fs::read_to_string(&path)
                        && let Ok(pid) = pid.trim().parse() {
                        break TestChild(pid);
                    }
                    sleep(Duration::from_millis(5)).await;
                }
            }) => {
                let pid = pid.expect("fake ssh should write its pid");
                assert!(exists(pid.0));
                pid
            },
        }
    };
    timeout(WAIT, async {
        while exists(pid.0) {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("cancelled SSH should be killed and reaped");
}

#[tokio::test]
async fn explicit_close_kills_and_reaps_ssh() {
    let (_dir, dialer) = fake_ssh("printf '%s\\n' \"$$\"\nexec /bin/sleep 30\n");
    let endpoint = endpoint();
    let stream = dialer.dial(&endpoint, &endpoint.targets[0]).await.unwrap();
    let mut reader = BufReader::new(stream.reader);
    let mut line = String::new();
    timeout(WAIT, reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let pid = TestChild(line.trim().parse().unwrap());
    assert!(exists(pid.0));
    timeout(WAIT, stream.close.close()).await.unwrap();
    assert!(!exists(pid.0));
}

const SSH_WITH_INHERITED_STDERR: &str = r#"
/bin/sleep 30 >&2 &
printf '%s\n' 'Host key verification failed.' >&2
printf '%s\n' "$!"
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inherited_stderr_does_not_delay_a_host_key_error() {
    let (_dir, dialer) = fake_ssh(SSH_WITH_INHERITED_STDERR);
    let endpoint = endpoint();
    let target = &endpoint.targets[0];
    let stream = dialer.dial(&endpoint, target).await.unwrap();
    let mut reader = BufReader::new(stream.reader);
    let mut line = String::new();
    timeout(WAIT, reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let descendant = TestChild(line.trim().parse().unwrap());
    assert!(exists(descendant.0));

    timeout(Duration::from_secs(2), stream.close.close())
        .await
        .expect("close must not wait for an inherited stderr");
    assert!(exists(descendant.0));
    assert!(matches!(
        dialer.classify(&DialFailure {
            target,
            stderr: &stream.stderr.text(),
            outcome: HandshakeFailure::Closed,
        }),
        RemoteError::HostKey(text) if text == "studio.local: Host key verification failed."
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stderr_pump_drains_buffered_bytes_when_started_after_ssh_exits() {
    let (_dir, dialer) = fake_ssh(SSH_WITH_INHERITED_STDERR);
    let endpoint = endpoint();
    let mut child = dialer
        .command(&endpoint, &endpoint.targets[0])
        .unwrap()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let descendant = TestChild(line.trim().parse().unwrap());
    assert!(exists(descendant.0));
    assert!(
        timeout(WAIT, child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );

    let (exit, exited) = oneshot::channel();
    let tail = StderrTail::default();
    exit.send(()).unwrap();
    let pump = tokio::spawn(pump_stderr(
        child.stderr.take().unwrap(),
        tail.clone(),
        exited,
    ));
    timeout(Duration::from_secs(2), pump)
        .await
        .expect("the drain must finish while the descendant holds stderr open")
        .unwrap();
    assert!(exists(descendant.0));
    assert_eq!(tail.text(), "Host key verification failed.");
}

#[tokio::test]
async fn stderr_is_drained_up_to_the_capture_limit() {
    let (_dir, dialer) = fake_ssh("printf 'first%09000dlast' 0 >&2");
    let endpoint = endpoint();
    let result = timeout(
        WAIT,
        statglass_session::connect(&dialer, &endpoint, LOCAL, None),
    )
    .await
    .unwrap();
    let mut expected = "studio.local: first".to_string();
    expected.push_str(&"0".repeat(STDERR_TAIL_BYTES - "first".len()));
    assert!(matches!(result, Err(RemoteError::Transport(text)) if text == expected));
}

#[tokio::test]
async fn an_exiting_ssh_child_delivers_its_stopped_agent_marker() {
    let (_dir, dialer) = fake_ssh(
        r#"
printf '%s\n' 'login banner' 'statglass-agent: not running' >&2
exit 1
"#,
    );
    let endpoint = endpoint();
    let result = timeout(
        WAIT,
        statglass_session::connect(&dialer, &endpoint, LOCAL, None),
    )
    .await
    .unwrap();
    assert!(matches!(
        result,
        Err(RemoteError::AgentNotRunning(host)) if host == "studio.local"
    ));
}

#[tokio::test]
async fn dropping_a_stream_kills_ssh_without_needing_close() {
    let (_dir, dialer) = fake_ssh("printf '%s\\n' \"$$\"\nexec /bin/sleep 30\n");
    let endpoint = endpoint();
    let mut stream = dialer.dial(&endpoint, &endpoint.targets[0]).await.unwrap();
    let mut reader = BufReader::new(&mut stream.reader);
    let mut line = String::new();
    timeout(WAIT, reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let pid = TestChild(line.trim().parse().unwrap());
    assert!(exists(pid.0));
    drop(stream);
    timeout(WAIT, async {
        while exists(pid.0) {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("dropped SSH stream should be killed and reaped");
}
