//! Pairing an iPhone with this host (RFC `plan/rfc-ios-app.md` 2.4): the interactive
//! `pair` that shows a QR and asks for approval on this terminal, and the forced
//! `pair --nonce` the one-time pairing key runs.
mod bundle;
mod terminal;

use anyhow::{Context, ensure};
use statglass_proto::pairing::{
    BundleTarget, PAIR_RECEIPT_GRACE, PairReply, PairingPayload, valid_nonce,
};
use statglass_remote::{
    AGENT_COMMAND_NOT_ALLOWED, AgentEnv, AgentLayout, AgentPaths, AuthorizedKeys, ControlRequest,
    ControlResponse, PairCommands, PairingHost, command::shell_quote,
    effective_user::EffectiveUser, pairing::run_forced_for_nonce, serve_control,
};
use std::future::Future;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Notify, watch};
use tokio::time::Instant;

/// Offers a pairing for `ttl` and asks for approval on this terminal.
pub fn interactive(
    ttl: Duration,
    targets: &[BundleTarget],
    port: Option<u16>,
) -> anyhow::Result<()> {
    let user = EffectiveUser::lookup().context("locating the pairing account")?;
    let uid = rustix::process::geteuid().as_raw();
    let env = pairing_env(AgentEnv::from_process(), user.home, uid);
    let socket_dir = pairing_directory(&env)?;
    let layout = AgentLayout::for_uid(uid);
    let paths = layout.paths(&env).context("locating this host's agent")?;
    ensure!(
        paths.binary.is_file(),
        "install StatGlass agent at {} before pairing",
        paths.binary.display()
    );
    bundle::check_ssh_version()?;
    let runtime = runtime()?;
    let result = runtime.block_on(async {
        let interrupt = pairing_interrupt().context("listening for terminal signals")?;
        let host = bundle::bundle(layout, &paths, user.name, targets, port).await?;
        let pairing = Arc::new(PairingHost::new(
            Arc::new(AuthorizedKeys::for_current_user()?),
            commands(layout, &paths, &env)?,
        ));
        let payload = pairing
            .offer(host, ttl, statglass_engine::wall_ms())
            .context("installing the one-time pairing key")?;
        let result = serve_offer(&pairing, &payload, socket_dir, interrupt).await;
        let cleanup = pairing
            .cancel(&payload.nonce)
            .context("removing the one-time pairing key");
        if result.is_err()
            && let Err(error) = &cleanup
        {
            tracing::warn!(
                error = &**error as &dyn std::error::Error,
                "pairing cleanup failed"
            );
        }
        result.and(cleanup)
    });
    // The terminal reader may still be blocked in read(2) after timeout or a signal.
    runtime.shutdown_background();
    result
}

/// Relays the phone's `PairStart` for `nonce` to the interactive pairing's socket;
/// returns the exit code.
pub fn forced(nonce: &str) -> anyhow::Result<i32> {
    if !valid_nonce(nonce) {
        eprintln!("statglass-agent: invalid pairing nonce");
        return Ok(2);
    }
    if std::env::var_os("SSH_ORIGINAL_COMMAND").is_some_and(|command| command != "pair") {
        eprintln!("{AGENT_COMMAND_NOT_ALLOWED}");
        return Ok(2);
    }
    let user = EffectiveUser::lookup().context("locating the pairing account")?;
    let uid = rustix::process::geteuid().as_raw();
    let env = pairing_env(AgentEnv::from_process(), user.home, uid);
    let path = pairing_directory(&env)?.join(socket_name(nonce));
    let runtime = runtime()?;
    let code = runtime.block_on(run_forced_for_nonce(
        tokio::io::stdin(),
        tokio::io::stdout(),
        &path,
        nonce,
    ));
    runtime.shutdown_background();
    Ok(code)
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("starting the pairing runtime")
}

fn pairing_env(mut env: AgentEnv, home: PathBuf, uid: u32) -> AgentEnv {
    env.home = Some(home);
    env.xdg_runtime_dir = env.xdg_runtime_dir.filter(|path| {
        std::fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == uid)
    });
    env
}

fn pairing_directory(env: &AgentEnv) -> anyhow::Result<PathBuf> {
    if let Some(runtime) = &env.xdg_runtime_dir {
        return Ok(runtime.join("statglass"));
    }
    Ok(env
        .home
        .as_ref()
        .context("the account home is needed to locate the pairing socket")?
        .join(".local/state/statglass"))
}

fn socket_name(nonce: &str) -> String {
    format!("pair-{nonce}.sock")
}

fn commands(
    layout: AgentLayout,
    paths: &AgentPaths,
    env: &AgentEnv,
) -> anyhow::Result<PairCommands> {
    let bin = shell_quote(
        paths
            .binary
            .to_str()
            .context("the agent's executable path is not UTF-8")?,
    );
    let pairing_runtime = match &env.xdg_runtime_dir {
        Some(path) => path
            .to_str()
            .context("the pairing runtime directory is not UTF-8")?,
        None => "",
    };
    let at = match layout {
        AgentLayout::System => "--system".into(),
        AgentLayout::User => format!(
            "--socket {}",
            shell_quote(
                paths
                    .socket
                    .to_str()
                    .context("the agent socket path is not UTF-8")?
            )
        ),
    };
    Ok(PairCommands {
        // sshd's environment can add, change, or omit XDG_RUNTIME_DIR.
        pair: format!(
            "/usr/bin/env XDG_RUNTIME_DIR={} {bin} pair",
            shell_quote(pairing_runtime)
        ),
        restricted: format!("{bin} restricted {at}"),
    })
}

async fn serve_offer(
    pairing: &Arc<PairingHost>,
    payload: &PairingPayload,
    socket_dir: PathBuf,
    interrupt: impl Future<Output = Option<()>>,
) -> anyhow::Result<()> {
    let pending = Arc::new(Notify::new());
    let handler = {
        let (pairing, pending) = (Arc::clone(pairing), Arc::clone(&pending));
        Arc::new(move |request| control_reply(&pairing, &pending, request))
    };
    let (shutdown, receiver) = watch::channel(false);
    let path = socket_dir.join(socket_name(&payload.nonce));
    let server = serve_control(path, handler, receiver);
    let remaining = payload
        .expires_ms
        .saturating_sub(statglass_engine::wall_ms())
        .max(0) as u64;
    let deadline = Instant::now() + Duration::from_millis(remaining);
    drive_offer(
        server,
        shutdown,
        interrupt,
        terminal::terminal_decision(pairing, payload, &pending, deadline),
        || pairing.cancel(&payload.nonce),
    )
    .await
}

fn pairing_interrupt() -> io::Result<impl Future<Output = Option<()>>> {
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut hangup = signal(SignalKind::hangup())?;
    Ok(async move {
        tokio::select! {
            received = interrupt.recv() => received,
            received = terminate.recv() => received,
            received = hangup.recv() => received,
        }
    })
}

async fn drive_offer(
    server: impl Future<Output = statglass_remote::Result<()>>,
    shutdown: watch::Sender<bool>,
    interrupt: impl Future<Output = Option<()>>,
    decision: impl Future<Output = anyhow::Result<bool>>,
    cancel: impl FnOnce() -> Result<(), statglass_remote::PairingError>,
) -> anyhow::Result<()> {
    tokio::pin!(server, interrupt, decision);
    let (reply, interrupted) = tokio::select! {
        // Poll the server first. Its bind is synchronous before its first await, so
        // there is a listening socket by the time the terminal shows the QR.
        biased;
        stopped = &mut server => return stopped.context("serving the private pairing socket"),
        _ = &mut interrupt => (Ok(true), true),
        answer = &mut decision => (answer, false),
    };
    let cleanup = if interrupted || reply.is_err() {
        cancel().context("cancelling the pairing offer")
    } else {
        Ok(())
    };
    if reply.is_err()
        && let Err(error) = &cleanup
    {
        tracing::warn!(
            error = &**error as &dyn std::error::Error,
            "pairing cancellation failed"
        );
    }
    if !matches!(reply, Ok(false)) {
        // A client can have a short control request in flight when the decision is
        // made. Keep serving through that request's cap and the following poll.
        tokio::select! {
            stopped = &mut server => return stopped.context("serving the final pairing reply"),
            _ = &mut interrupt, if !interrupted => {},
            () = tokio::time::sleep(PAIR_RECEIPT_GRACE) => {},
        }
    }
    let _ = shutdown.send(true);
    server.await.context("closing the private pairing socket")?;
    reply.map(|_| ()).and(cleanup)
}

fn control_reply(
    pairing: &PairingHost,
    pending: &Notify,
    request: ControlRequest,
) -> ControlResponse {
    let start = matches!(request, ControlRequest::PairStart { .. });
    let response = pairing.control_reply(request, statglass_engine::wall_ms());
    if start && response.pairing == Some(PairReply::Waiting) {
        pending.notify_one();
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Command, DeviceCommand, parse};
    use rustix::process::{Pid, Signal as ProcessSignal, kill_process};
    use statglass_proto::pairing::{BundleHost, PairStart, decode_payload};
    use statglass_remote::{
        DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public, PairedDevice, control_request,
    };
    use std::path::Path;
    use tokio::io::{AsyncBufReadExt, BufReader};

    struct TestKeys {
        line: PathBuf,
    }

    impl DeviceKeys for TestKeys {
        fn list_devices(&self) -> Result<Vec<PairedDevice>, DeviceKeysError> {
            unreachable!()
        }
        fn add_device(
            &self,
            _key: &EcdsaP256Public,
            _name: &str,
            _command: &str,
        ) -> Result<DeviceTag, DeviceKeysError> {
            Err(io::Error::other("device key write failed").into())
        }
        fn revoke(&self, _tag: DeviceTag) -> Result<bool, DeviceKeysError> {
            unreachable!()
        }
        fn add_pairing(
            &self,
            _key: &EcdsaP256Public,
            nonce: &str,
            _expires_ms: i64,
            _command: &str,
        ) -> Result<(), DeviceKeysError> {
            Ok(std::fs::write(&self.line, nonce)?)
        }
        fn remove_pairing(&self, _nonce: &str) -> Result<bool, DeviceKeysError> {
            Ok(match std::fs::remove_file(&self.line) {
                Ok(()) => true,
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.into()),
            })
        }
    }

    fn test_offer(dir: &Path) -> (Arc<PairingHost>, PairingPayload) {
        let pairing = Arc::new(PairingHost::new(
            Arc::new(TestKeys {
                line: dir.join("pairing-line"),
            }),
            PairCommands {
                pair: "/agent pair".into(),
                restricted: "/agent restricted".into(),
            },
        ));
        let host = BundleHost {
            host_id: statglass_schema::HostId(uuid::Uuid::nil()),
            name: "test".into(),
            os: "test".into(),
            user: "test".into(),
            port: None,
            targets: vec![],
            host_keys: vec![],
        };
        let payload = pairing
            .offer(host, Duration::from_secs(60), statglass_engine::wall_ms())
            .expect("offer pairing with fake device keys");
        (pairing, payload)
    }

    fn test_start(nonce: &str) -> ControlRequest {
        // SEC1 uncompressed NIST P-256 generator point.
        let hex = concat!(
            "04",
            "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
            "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
        );
        let device_key = (0..hex.len())
            .step_by(2)
            .map(|index| {
                u8::from_str_radix(&hex[index..index + 2], 16).expect("test device key byte")
            })
            .collect();
        ControlRequest::PairStart {
            start: PairStart {
                nonce: nonce.into(),
                device_key,
                device_name: "Test phone".into(),
                model: "iPhone".into(),
            },
            attempt: [7; 16],
        }
    }

    fn parse_pair(args: &[&str]) -> anyhow::Result<Command> {
        parse(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn pair_cli_parses_both_forms_and_defaults_to_ten_minutes() {
        assert!(matches!(
            parse_pair(&["pair"]).unwrap(),
            Command::Device(DeviceCommand::Pair { ttl_s: 600, targets, port: None }) if targets.is_empty()
        ));
        assert!(matches!(
            parse_pair(&["pair", "--ttl", "60"]).unwrap(),
            Command::Device(DeviceCommand::Pair { ttl_s: 60, targets, port: None }) if targets.is_empty()
        ));
        assert!(
            matches!(parse_pair(&["pair", "--nonce", "abc"]).unwrap(), Command::Device(DeviceCommand::PairForced { nonce }) if nonce == "abc")
        );
    }

    #[test]
    fn pair_cli_rejects_bad_flags_missing_values_and_combining_forms() {
        for args in [
            &["pair", "--ttl"][..],
            &["pair", "--nonce"],
            &["pair", "--ttl", "0"],
            &["pair", "--ttl", "3601"],
            &["pair", "--ttl", "x"],
            &["pair", "--system"],
            &["pair", "--ttl", "1", "--nonce", "abc"],
        ] {
            assert!(parse_pair(args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn pairing_cli_preserves_all_four_targets_in_order_and_the_published_port() {
        let parsed = parse_pair(&[
            "pair",
            "--target",
            "lan=127.0.0.1",
            "--port",
            "65535",
            "--target",
            "tailscale=100.64.1.1",
            "--target",
            "lan=office.local",
            "--target",
            "tailscale=fd7a:115c:a1e0::1",
        ])
        .unwrap();
        use statglass_proto::pairing::BundleRoute::{Lan, Tailscale};
        assert_eq!(
            parsed,
            Command::Device(DeviceCommand::Pair {
                ttl_s: 600,
                port: Some(65535),
                targets: [
                    (Lan, "127.0.0.1"),
                    (Tailscale, "100.64.1.1"),
                    (Lan, "office.local"),
                    (Tailscale, "fd7a:115c:a1e0::1"),
                ]
                .into_iter()
                .map(|(route, host)| BundleTarget {
                    route,
                    host: host.into()
                })
                .collect(),
            })
        );
    }

    #[test]
    fn pair_forces_the_installed_binary_and_preserves_the_terminal_runtime_directory() {
        let mut env = AgentEnv {
            home: Some("/home/pair owner".into()),
            ..AgentEnv::default()
        };
        let paths = AgentLayout::User.paths(&env).unwrap();
        let script = commands(AgentLayout::User, &paths, &env).unwrap();
        assert_eq!(
            script.pair,
            "/usr/bin/env XDG_RUNTIME_DIR='' '/home/pair owner/.local/bin/statglass-agent' pair"
        );
        assert_eq!(
            script.restricted,
            "'/home/pair owner/.local/bin/statglass-agent' restricted --socket '/home/pair owner/.local/state/statglass-agent/metrics.sock'"
        );
        env.xdg_runtime_dir = Some("/run/custom place".into());
        let script = commands(AgentLayout::User, &paths, &env).unwrap();
        assert_eq!(
            script.pair,
            "/usr/bin/env XDG_RUNTIME_DIR='/run/custom place' '/home/pair owner/.local/bin/statglass-agent' pair"
        );
    }

    #[tokio::test]
    async fn pair_keeps_serving_a_final_status_after_the_terminal_edit_reports_an_error() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let (pairing, payload) = test_offer(dir.path());
        let nonce = &payload.nonce;
        let pending = Notify::new();
        assert_eq!(
            control_reply(&pairing, &pending, test_start(nonce)).pairing,
            Some(PairReply::Waiting)
        );
        let (shutdown, mut closed) = watch::channel(false);
        let (decided, outcome) = tokio::sync::oneshot::channel();
        let (polled, final_status) = tokio::sync::oneshot::channel();
        let server = async {
            outcome.await.unwrap();
            let response = control_reply(
                &pairing,
                &pending,
                ControlRequest::PairStatus {
                    nonce: nonce.clone(),
                },
            );
            assert_eq!(response.pairing, Some(PairReply::Denied));
            polled.send(()).unwrap();
            closed.changed().await.unwrap();
            Ok(())
        };
        let decision = async {
            decided.send(()).unwrap();
            pairing
                .approve(nonce, statglass_engine::wall_ms())
                .context("installing the approved device key")?;
            Ok(true)
        };
        let interrupt = async { final_status.await.ok() };
        let result = drive_offer(server, shutdown, interrupt, decision, || {
            pairing.cancel(nonce)
        })
        .await;
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("installing the approved device key")
        );
        assert!(*closed.borrow());
    }

    const SIGNAL_FIXTURE: &str = "STATGLASS_TEST_PAIR_SIGNAL_FIXTURE";

    async fn pair_signal_case(signal: ProcessSignal) -> (String, bool) {
        let dir = tempfile::tempdir_in("/tmp").expect("short pairing socket directory");
        let mut command =
            tokio::process::Command::new(std::env::current_exe().expect("agent test executable"));
        command
            .args([
                "--exact",
                "pair::tests::pair_cleans_up_on_terminal_signals",
                "--nocapture",
            ])
            .env(SIGNAL_FIXTURE, dir.path())
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        let mut child = command.spawn().expect("start interactive pairing fixture");
        let mut output = BufReader::new(child.stdout.take().expect("child stdout")).lines();
        let payload = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let line = output
                    .next_line()
                    .await
                    .expect("read pairing output")
                    .expect("child should offer pairing");
                if let Some(start) = line.find("SGP1:") {
                    break decode_payload(&line[start..], statglass_engine::wall_ms())
                        .expect("decode test pairing offer");
                }
            }
        })
        .await
        .expect("child should print the offer");
        let socket = dir.path().join(socket_name(&payload.nonce));
        assert!(socket.exists());
        assert!(dir.path().join("pairing-line").exists());
        let waiting = control_request(&socket, &test_start(&payload.nonce))
            .await
            .expect("start pairing before signaling");
        assert_eq!(waiting.pairing, Some(PairReply::Waiting));
        let pid = Pid::from_raw(i32::try_from(child.id().expect("live child")).expect("valid PID"))
            .expect("nonzero PID");
        kill_process(pid, signal).expect("signal the pairing child");
        let status = ControlRequest::PairStatus {
            nonce: payload.nonce,
        };
        let denied = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match control_request(&socket, &status).await {
                    Ok(response) if response.pairing == Some(PairReply::Waiting) => {}
                    Ok(response) => break response.pairing == Some(PairReply::Denied),
                    Err(_) => break false,
                }
            }
        })
        .await
        .unwrap_or(false);
        // Keep the terminal stdin alive while the child processes the signal.
        let mut stdin = child.stdin.take();
        let exit = tokio::time::timeout(Duration::from_secs(15), child.wait())
            .await
            .expect("signal cleanup should finish")
            .expect("wait for child");
        drop(stdin.take());
        (
            format!("{signal:?}"),
            denied
                && exit.success()
                && !socket.exists()
                && !dir.path().join("pairing-line").exists(),
        )
    }

    #[test]
    fn pair_cleans_up_on_terminal_signals() {
        let runtime = runtime().unwrap();
        if let Some(dir) = std::env::var_os(SIGNAL_FIXTURE) {
            runtime.block_on(async {
                let dir = PathBuf::from(dir);
                let interrupt = pairing_interrupt().unwrap();
                let (pairing, payload) = test_offer(&dir);
                serve_offer(&pairing, &payload, dir, interrupt)
                    .await
                    .unwrap();
                pairing.cancel(&payload.nonce).unwrap();
            });
            runtime.shutdown_background();
            return;
        }
        let (interrupt, terminate, hangup) = runtime.block_on(async {
            tokio::join!(
                pair_signal_case(ProcessSignal::INT),
                pair_signal_case(ProcessSignal::TERM),
                pair_signal_case(ProcessSignal::HUP)
            )
        });
        let results = [interrupt, terminate, hangup];
        assert!(
            results.iter().all(|(_, cleaned)| *cleaned),
            "signal denial and cleanup: {results:?}"
        );
    }

    #[test]
    fn pair_socket_uses_only_a_runtime_directory_owned_by_the_effective_uid() {
        let runtime = tempfile::tempdir().unwrap();
        let uid = rustix::process::geteuid().as_raw();
        let env = AgentEnv {
            xdg_runtime_dir: Some(runtime.path().into()),
            ..AgentEnv::default()
        };
        let home = PathBuf::from("/home/me");
        let owned = pairing_env(env.clone(), home.clone(), uid);
        assert_eq!(
            pairing_directory(&owned).unwrap(),
            runtime.path().join("statglass")
        );

        let foreign = pairing_env(env, home, uid ^ 1);
        assert!(foreign.xdg_runtime_dir.is_none());
        assert_eq!(
            pairing_directory(&foreign).unwrap(),
            Path::new("/home/me/.local/state/statglass")
        );
    }

    #[test]
    fn pairing_home_and_login_ignore_inherited_home_and_user() {
        const EXPECTED_HOME: &str = "STATGLASS_TEST_PAIR_ACCOUNT_HOME";
        const EXPECTED_LOGIN: &str = "STATGLASS_TEST_PAIR_ACCOUNT_LOGIN";
        let user = EffectiveUser::lookup().unwrap();
        if let Some(home) = std::env::var_os(EXPECTED_HOME) {
            let uid = rustix::process::geteuid().as_raw();
            let env = pairing_env(AgentEnv::from_process(), user.home, uid);
            assert_eq!(user.name, std::env::var_os(EXPECTED_LOGIN).unwrap());
            assert_eq!(
                pairing_directory(&env).unwrap(),
                Path::new(&home).join(".local/state/statglass")
            );
            return;
        }

        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "pair::tests::pairing_home_and_login_ignore_inherited_home_and_user",
            ])
            .env("HOME", "/fake-pairing-home")
            .env("USER", "fake-pairing-user")
            .env_remove("XDG_RUNTIME_DIR")
            .env(EXPECTED_HOME, user.home)
            .env(EXPECTED_LOGIN, user.name)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}
