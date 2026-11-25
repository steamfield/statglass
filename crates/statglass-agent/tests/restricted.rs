use statglass_remote::{
    AGENT_COMMAND_NOT_ALLOWED, AGENT_NOT_RUNNING, DeviceTag, SessionScope, encode_preface,
};
use std::{
    ffi::OsString,
    os::unix::ffi::OsStringExt,
    path::Path,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
    process::Command,
};

fn agent(original: Option<&std::ffi::OsStr>) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_statglass-agent"));
    command.kill_on_drop(true);
    match original {
        Some(original) => {
            command.env("SSH_ORIGINAL_COMMAND", original);
        }
        None => {
            command.env_remove("SSH_ORIGINAL_COMMAND");
        }
    }
    command
}

fn restricted(socket: &Path, original: Option<&str>) -> Command {
    let mut command = agent(original.map(std::ffi::OsStr::new));
    command
        .args(["restricted", "--device", "7F3A2C", "--socket"])
        .arg(socket);
    command
}

async fn output(command: &mut Command) -> Output {
    tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .expect("agent command must exit")
        .expect("run the agent")
}

#[tokio::test]
async fn forbidden_tokens_and_invalid_tags_exit_two_without_connecting() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let path = dir.path().join("agent.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let invalid_utf8 = OsString::from_vec(vec![0xff]);
    for original in ["serve --stdio", "serve;id", "serve ", "", "pair", "Serve"]
        .into_iter()
        .map(std::ffi::OsStr::new)
        .chain([invalid_utf8.as_os_str()])
    {
        let result = output(
            agent(Some(original))
                .args(["restricted", "--device", "7F3A2C", "--socket"])
                .arg(&path),
        )
        .await;
        assert_eq!(result.status.code(), Some(2), "{original:?}");
        assert!(result.stdout.is_empty());
        assert_eq!(
            result.stderr,
            format!("{AGENT_COMMAND_NOT_ALLOWED}\n").as_bytes()
        );
    }
    let bad_tag = output(
        agent(Some("serve".as_ref()))
            .args(["restricted", "--device", "7f3a2c", "--socket"])
            .arg(&path),
    )
    .await;
    assert_eq!(bad_tag.status.code(), Some(2));
    assert_eq!(bad_tag.stderr, b"statglass-agent: invalid device tag\n");
    assert!(
        listener.into_std().unwrap().accept().unwrap_err().kind() == std::io::ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn serve_and_an_unset_command_prefix_the_bridge_with_the_device() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let path = dir.path().join("agent.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let device = DeviceTag::parse("7F3A2C").unwrap();
    let mut expected = encode_preface(&SessionScope::Restricted { device });
    expected.extend_from_slice(b"controller");
    for original in [None, Some("serve")] {
        let mut command = restricted(&path, original);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        input.write_all(b"controller").await.unwrap();
        drop(input);
        let (result, received) = tokio::time::timeout(Duration::from_secs(5), async {
            let relay = async {
                let (mut conn, _) = listener.accept().await.unwrap();
                let mut received = Vec::new();
                conn.read_to_end(&mut received).await.unwrap();
                conn.write_all(b"host").await.unwrap();
                received
            };
            tokio::join!(child.wait_with_output(), relay)
        })
        .await
        .unwrap();
        assert_eq!(received, expected);
        let result = result.unwrap();
        assert!(result.status.success(), "{:?}", result.stderr);
        assert_eq!(result.stdout, b"host");
        assert!(result.stderr.is_empty());
    }
}

#[tokio::test]
async fn version_and_status_print_and_stopped_serve_has_its_marker() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let path = dir.path().join("agent.sock");
    let version = output(agent(Some("version".as_ref())).args([
        "restricted",
        "--device",
        "7F3A2C",
        "--system",
    ]))
    .await;
    let ordinary = output(agent(None).arg("version")).await;
    assert!(version.status.success());
    assert_eq!(version.stdout, ordinary.stdout);
    assert!(version.stderr.is_empty());

    let status = output(&mut restricted(&path, Some("status"))).await;
    assert!(status.status.success());
    assert_eq!(status.stdout, b"{\"running\":false}\n");
    assert!(status.stderr.is_empty());
    let listener = UnixListener::bind(&path).unwrap();
    let running = output(&mut restricted(&path, Some("status"))).await;
    assert!(running.status.success());
    assert_eq!(running.stdout, b"{\"running\":true}\n");
    assert!(running.stderr.is_empty());
    drop(listener);
    let stopped = output(&mut restricted(&path, Some("serve"))).await;
    assert_eq!(stopped.status.code(), Some(3));
    assert!(stopped.stdout.is_empty());
    assert_eq!(stopped.stderr, format!("{AGENT_NOT_RUNNING}\n").as_bytes());
}

#[tokio::test]
async fn malformed_restricted_invocations_fail_at_the_cli() {
    for args in [
        &["restricted"][..],
        &["restricted", "--device"][..],
        &["restricted", "--device", "7F3A2C", "--stdio"][..],
        &["restricted", "--device", "7F3A2C", "serve"][..],
    ] {
        let result = output(agent(None).args(args)).await;
        assert_eq!(result.status.code(), Some(1), "{args:?}");
        assert!(result.stdout.is_empty());
        assert!(!result.stderr.is_empty());
    }
}
