use statglass_remote::{
    HELPER_COMMAND_NOT_ALLOWED, SocketPaths,
    scope::{APP_NOT_RUNNING, MONITORING_OFF},
};
use std::{
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
    process::Command,
};

const RESTRICTED: &[&str] = &["restricted", "--device", "7F3A2C"];

struct Fixture {
    home: tempfile::TempDir,
    paths: SocketPaths,
}

impl Fixture {
    fn new() -> Self {
        let home = tempfile::tempdir_in("/tmp").expect("create a short socket path");
        let paths = SocketPaths::new(
            home.path()
                .join("Library/Application Support/com.tryopendata.statglass"),
        );
        std::fs::create_dir_all(paths.metrics.parent().expect("socket directory"))
            .expect("create test app data");
        Self { home, paths }
    }

    fn helper(&self, args: &[&str], original: Option<&str>) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_statglass-remote-helper"));
        command
            .args(args)
            .env("HOME", self.home.path())
            .kill_on_drop(true);
        if let Some(original) = original {
            command.env("SSH_ORIGINAL_COMMAND", original);
        } else {
            command.env_remove("SSH_ORIGINAL_COMMAND");
        }
        command
    }

    async fn output(&self, args: &[&str], original: Option<&str>) -> Output {
        tokio::time::timeout(
            Duration::from_secs(12),
            self.helper(args, original).output(),
        )
        .await
        .expect("the helper must exit")
        .expect("run the helper")
    }
}

#[tokio::test]
async fn restricted_cli_accepts_bare_version_and_status_and_rejects_other_commands() {
    let fixture = Fixture::new();
    let listener = UnixListener::bind(&fixture.paths.metrics).unwrap();
    for token in ["serve --stdio", "serve;id", "serve ", "", "pair"] {
        let result = fixture.output(RESTRICTED, Some(token)).await;
        assert_eq!(result.status.code(), Some(2), "{token:?}");
        assert!(result.stdout.is_empty());
        assert_eq!(
            result.stderr,
            format!("{HELPER_COMMAND_NOT_ALLOWED}\n").as_bytes()
        );
    }
    let bad_tag = fixture
        .output(&["restricted", "--device", "7f3a2c"], Some("serve"))
        .await;
    assert_eq!(bad_tag.status.code(), Some(2));
    assert_eq!(
        bad_tag.stderr,
        b"statglass-remote-helper: invalid device tag\n"
    );

    let full = fixture.output(&["version", "--json"], None).await;
    let version = fixture.output(RESTRICTED, Some("version")).await;
    assert!(version.status.success());
    assert!(version.stderr.is_empty());
    assert_eq!(version.stdout, full.stdout);

    let status = fixture.output(RESTRICTED, Some("status")).await;
    assert!(status.status.success());
    assert!(status.stderr.is_empty());
    let parsed = serde_json::from_slice::<serde_json::Value>(&status.stdout).unwrap();
    assert_eq!(parsed["ok"], false);
    assert_eq!(
        listener.into_std().unwrap().accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn both_serve_modes_print_the_exact_unavailable_markers_and_exit_three() {
    let fixture = Fixture::new();
    let (full, restricted) = (&["serve", "--stdio"][..], RESTRICTED);
    for args in [full, restricted] {
        let result = fixture.output(args, Some("serve")).await;
        assert_eq!(result.status.code(), Some(3));
        assert!(result.stdout.is_empty());
        assert_eq!(result.stderr, format!("{APP_NOT_RUNNING}\n").as_bytes());
    }
    // Closing the listener keeps its path present, giving a refused metrics connect.
    drop(UnixListener::bind(&fixture.paths.metrics).unwrap());
    let control = UnixListener::bind(&fixture.paths.control).unwrap();
    for args in [full, restricted] {
        let (result, ()) = tokio::join!(fixture.output(args, Some("serve")), async {
            let (mut channel, _) = tokio::time::timeout(Duration::from_secs(3), control.accept())
                .await
                .unwrap()
                .unwrap();
            let size = channel.read_u32().await.unwrap() as usize;
            let mut request = vec![0; size];
            channel.read_exact(&mut request).await.unwrap();
            assert_eq!(request, br#"{"operation":"status"}"#);
            let response =
                br#"{"ok":true,"message":"","host":null,"allow_remote_monitoring":false}"#;
            channel.write_u32(response.len() as u32).await.unwrap();
            channel.write_all(response).await.unwrap();
        });
        assert_eq!(result.status.code(), Some(3));
        assert!(result.stdout.is_empty());
        assert_eq!(result.stderr, format!("{MONITORING_OFF}\n").as_bytes());
    }
}

#[tokio::test]
async fn restricted_serve_prefixes_stdin_when_serve_is_explicit_or_unset() {
    let fixture = Fixture::new();
    let metrics = UnixListener::bind(&fixture.paths.metrics).unwrap();
    for original in [None, Some("serve")] {
        let mut child = fixture
            .helper(RESTRICTED, original)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"controller").await.unwrap();
        let (output, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(child.wait_with_output(), async {
                let (mut channel, _) = metrics.accept().await.unwrap();
                let mut prefix = [0; 4];
                channel.read_exact(&mut prefix).await.unwrap();
                assert_eq!(&prefix, b"SGSP");
                let size = channel.read_u16().await.unwrap() as usize;
                let mut body = vec![0; size];
                channel.read_exact(&mut body).await.unwrap();
                assert_eq!(body, br#"{"scope":"restricted","device":"7F3A2C"}"#);
                let mut stdin_bytes = [0; 10];
                channel.read_exact(&mut stdin_bytes).await.unwrap();
                assert_eq!(&stdin_bytes, b"controller");
                channel.write_all(b"host").await.unwrap();
            })
        })
        .await
        .unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, b"host");
        assert!(output.stderr.is_empty());
        drop(stdin);
    }
}
