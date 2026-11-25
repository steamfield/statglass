//! Pairing an iPhone with this host (RFC `plan/rfc-ios-app.md` 2.4): the interactive
//! `pair` that shows a QR and asks for approval on this terminal, and the forced
//! `pair --nonce` the one-time pairing key runs.
use anyhow::{Context, ensure};
use qrcode::{EcLevel, QrCode, render::unicode::Dense1x2};
use statglass_proto::pairing::{
    BundleHost, BundleHostKey, BundleRoute, BundleTarget, PAIR_RECEIPT_GRACE, PairError, PairReply,
    PairingPayload, encode_payload, valid_nonce,
};
use statglass_remote::{
    AgentEnv, AgentLayout, AgentPaths, AuthorizedKeys, ControlRequest, ControlResponse,
    PairCommands, PairingHost,
    network::{AddressClass, classify_address, counts_toward_online},
    pairing::{MAX_TARGETS, run_forced_for_nonce, shell_quote, usable_interface_addresses},
    serve_control,
};
use std::future::Future;
use std::io::{self, IsTerminal, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::sync::{Notify, watch};
use tokio::time::Instant;

/// Offers a pairing for `ttl` and asks for approval on this terminal.
pub fn interactive(ttl: Duration) -> anyhow::Result<()> {
    let env = AgentEnv::from_process();
    let socket_dir = pairing_directory(&env)?;
    let layout = AgentLayout::for_uid(rustix::process::geteuid().as_raw());
    let paths = layout.paths(&env).context("locating this host's agent")?;
    ensure!(
        paths.binary.is_file(),
        "install StatGlass agent at {} before pairing",
        paths.binary.display()
    );
    check_ssh_version()?;
    let runtime = runtime()?;
    let result = runtime.block_on(async {
        let mut interrupt = signal(SignalKind::interrupt()).context("listening for Ctrl-C")?;
        let host = bundle(layout, &paths).await?;
        let pairing = Arc::new(PairingHost::new(
            Arc::new(AuthorizedKeys::for_current_user()?),
            commands(layout, &paths, &env)?,
        ));
        let payload = pairing
            .offer(host, ttl, statglass_engine::wall_ms())
            .context("installing the one-time pairing key")?;
        let result = serve_offer(&pairing, &payload, socket_dir, &mut interrupt).await;
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
    // The terminal reader may still be blocked in read(2) after timeout or Ctrl-C.
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
        eprintln!("statglass-agent: command not allowed");
        return Ok(2);
    }
    let env = AgentEnv::from_process();
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

fn pairing_directory(env: &AgentEnv) -> anyhow::Result<PathBuf> {
    if let Some(runtime) = &env.xdg_runtime_dir {
        return Ok(runtime.join("statglass"));
    }
    Ok(env
        .home
        .as_ref()
        .context("HOME is needed to locate the pairing socket")?
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

async fn bundle(layout: AgentLayout, paths: &AgentPaths) -> anyhow::Result<BundleHost> {
    let status = crate::commands::status(layout, paths).await;
    ensure!(
        status["running"].as_bool() == Some(true),
        "start the StatGlass agent on {} before pairing",
        paths.socket.display()
    );
    let id = status["host_id"]
        .as_str()
        .context("the agent did not report a host identity")?
        .parse()
        .context("decoding the agent's host identity")?;
    let info = statglass_engine::host_record(statglass_schema::HostId(id));
    let user = std::env::var("USER").context("USER is needed for the SSH login")?;
    ensure!(!user.is_empty(), "USER is empty");
    let addresses =
        usable_interface_addresses().context("reading this host's interface addresses")?;
    let targets = bundle_targets(&info.display_name, &addresses);
    ensure!(
        !targets.is_empty(),
        "this host has no LAN or Tailscale address for the phone to dial"
    );
    let host_keys = host_keys(Path::new("/etc/ssh")).context(
        "Pairing uses OpenSSH on port 22 with standard SSH host public-key files in /etc/ssh",
    )?;
    Ok(BundleHost {
        host_id: info.id,
        name: info.display_name,
        os: std::env::consts::OS.into(),
        user,
        port: None,
        targets,
        host_keys,
    })
}

fn bundle_targets(hostname: &str, addresses: &[(String, IpAddr)]) -> Vec<BundleTarget> {
    let mut lan = Vec::new();
    let mut tailscale = Vec::new();
    for (name, address) in addresses {
        let (targets, route) = match classify_address(*address) {
            AddressClass::Ignored => continue,
            AddressClass::Tailscale if name.starts_with("tailscale") => {
                (&mut tailscale, BundleRoute::Tailscale)
            }
            _ if counts_toward_online(name)
                && !["br-", "virbr", "tun", "tap", "wg"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix)) =>
            {
                (&mut lan, BundleRoute::Lan)
            }
            _ => continue,
        };
        let target = BundleTarget {
            route,
            host: address.to_string(),
        };
        if !targets.contains(&target) && targets.len() < MAX_TARGETS {
            targets.push(target);
        }
    }
    let hostname = hostname.trim_end_matches('.');
    if !lan.is_empty()
        && !hostname.is_empty()
        && hostname
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        && !hostname.starts_with('-')
    {
        lan.retain(|target| target.host != hostname);
        lan.insert(
            0,
            BundleTarget {
                route: BundleRoute::Lan,
                host: hostname.into(),
            },
        );
    }
    tailscale.sort_by_key(|target| target.host.contains(':'));
    lan.truncate(MAX_TARGETS - usize::from(!tailscale.is_empty()));
    lan.extend(tailscale);
    lan.truncate(MAX_TARGETS);
    lan
}

fn host_keys(dir: &Path) -> anyhow::Result<Vec<BundleHostKey>> {
    let mut keys = Vec::new();
    let paths = std::fs::read_dir(dir)
        .with_context(|| format!("reading SSH host keys in {}", dir.display()))?;
    for path in paths {
        let path = path?.path();
        if !path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|name| name.starts_with("ssh_host_") && name.ends_with("_key.pub"))
        {
            continue;
        }
        let public = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let algorithm = public
            .split_whitespace()
            .next()
            .with_context(|| format!("{} has no SSH key", path.display()))?;
        let output = Command::new("ssh-keygen")
            .args(["-l", "-E", "sha256", "-f"])
            .arg(&path)
            .output()
            .with_context(|| format!("fingerprinting {}", path.display()))?;
        ensure!(
            output.status.success(),
            "ssh-keygen could not fingerprint {}",
            path.display()
        );
        let line = String::from_utf8_lossy(&output.stdout);
        let sha256 = line
            .split_whitespace()
            .nth(1)
            .filter(|value| value.starts_with("SHA256:"))
            .with_context(|| format!("{} has no SHA256 fingerprint", path.display()))?;
        keys.push(BundleHostKey {
            algorithm: algorithm.into(),
            sha256: sha256.into(),
        });
    }
    ensure!(
        !keys.is_empty(),
        "no SSH host public keys found in {}",
        dir.display()
    );
    keys.sort_by(|a, b| {
        a.algorithm
            .cmp(&b.algorithm)
            .then_with(|| a.sha256.cmp(&b.sha256))
    });
    Ok(keys)
}

fn check_ssh_version() -> anyhow::Result<()> {
    let version = match Command::new("ssh").arg("-V").output() {
        Ok(output) => {
            let mut version = output.stderr;
            version.extend(output.stdout);
            version
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &dyn std::error::Error,
                "could not check the OpenSSH version"
            );
            return Ok(());
        }
    };
    if let Some(version) = openssh_version(&String::from_utf8_lossy(&version)) {
        ensure!(
            version >= (7, 7),
            "pairing requires OpenSSH 7.7 or later for expiring SSH keys; update OpenSSH and retry"
        );
    } else {
        tracing::warn!("could not recognize the OpenSSH version");
    }
    Ok(())
}

fn openssh_version(output: &str) -> Option<(u32, u32)> {
    let (_, version) = output.split_once("OpenSSH_")?;
    let (major, rest) = version.split_once('.')?;
    let minor = rest.split(|ch: char| !ch.is_ascii_digit()).next()?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

async fn serve_offer(
    pairing: &Arc<PairingHost>,
    payload: &PairingPayload,
    socket_dir: PathBuf,
    interrupt: &mut Signal,
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
        interrupt.recv(),
        terminal_decision(pairing, payload, &pending, deadline),
    )
    .await
}

async fn drive_offer(
    server: impl Future<Output = statglass_remote::Result<()>>,
    shutdown: watch::Sender<bool>,
    interrupt: impl Future<Output = Option<()>>,
    decision: impl Future<Output = anyhow::Result<bool>>,
) -> anyhow::Result<()> {
    tokio::pin!(server, interrupt, decision);
    let reply = tokio::select! {
        // Poll the server first. Its bind is synchronous before its first await, so
        // there is a listening socket by the time the terminal shows the QR.
        biased;
        stopped = &mut server => return stopped.context("serving the private pairing socket"),
        _ = &mut interrupt => return Ok(()),
        answer = &mut decision => answer,
    };
    if !matches!(reply, Ok(false)) {
        // A client can have a short control request in flight when the decision is
        // made. Keep serving through that request's cap and the following poll.
        tokio::select! {
            stopped = &mut server => return stopped.context("serving the final pairing reply"),
            _ = &mut interrupt => {},
            () = tokio::time::sleep(PAIR_RECEIPT_GRACE) => {},
        }
    }
    let _ = shutdown.send(true);
    server.await.context("closing the private pairing socket")?;
    reply.map(|_| ())
}

fn control_reply(
    pairing: &PairingHost,
    pending: &Notify,
    request: ControlRequest,
) -> ControlResponse {
    let now = statglass_engine::wall_ms();
    let reply = match request {
        ControlRequest::PairStart { start, attempt } => {
            let reply = pairing.start_attempt(&start, attempt, now);
            if reply == PairReply::Waiting {
                pending.notify_one();
            }
            reply
        }
        ControlRequest::PairStatus { nonce } => pairing.status(&nonce, now),
        _ => PairReply::Error {
            error: PairError::Unavailable,
        },
    };
    ControlResponse {
        ok: !matches!(reply, PairReply::Error { .. }),
        message: String::new(),
        host: None,
        allow_remote_monitoring: None,
        show_menu_bar_icon: None,
        launch_at_login: None,
        updates: None,
        pairing: Some(reply),
    }
}

async fn terminal_decision(
    pairing: &PairingHost,
    payload: &PairingPayload,
    pending: &Notify,
    deadline: Instant,
) -> anyhow::Result<bool> {
    let text = encode_payload(payload);
    let qr = terminal_qr(&text)?;
    {
        let mut stdout = io::stdout().lock();
        if stdout.is_terminal() {
            let width = qr
                .lines()
                .map(|line| line.chars().count())
                .max()
                .unwrap_or_default();
            let columns = std::env::var("COLUMNS")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(80);
            if width > columns {
                eprintln!("Widen the terminal to {width} columns before scanning this QR.");
            }
        }
        writeln!(stdout, "{text}\n{qr}\nPairing code: {}", payload.code)?;
        stdout.flush()?;
    }
    let received = tokio::time::timeout_at(deadline, pending.notified())
        .await
        .is_ok();
    let nonce = &payload.nonce;
    let answer = pairing.pending(nonce, statglass_engine::wall_ms());
    if let PairReply::Pending {
        device_name,
        model,
        code,
    } = answer
    {
        writeln!(
            io::stdout(),
            "Approve {device_name} ({model}), code {code}? [y/N]"
        )?;
        io::stdout().flush()?;
        let input = tokio::task::spawn_blocking(|| {
            let mut line = String::new();
            io::stdin().read_line(&mut line).map(|_| line)
        });
        match tokio::time::timeout_at(deadline, input).await {
            Ok(input) => {
                let input = input
                    .context("reading the approval prompt")?
                    .context("reading the terminal")?;
                if input.trim().eq_ignore_ascii_case("y") {
                    pairing
                        .approve(nonce, statglass_engine::wall_ms())
                        .context("installing the approved device key")?;
                } else {
                    pairing.deny(nonce).context("denying the pairing")?;
                }
            }
            Err(_) => pairing.expire(payload.expires_ms),
        }
    } else if !received {
        pairing.expire(payload.expires_ms);
    }
    match pairing.status(nonce, statglass_engine::wall_ms()) {
        PairReply::Approved { .. } => writeln!(io::stdout(), "Pairing approved")?,
        PairReply::Denied => writeln!(io::stdout(), "Pairing denied")?,
        PairReply::Expired => writeln!(io::stdout(), "Pairing expired")?,
        _ => {}
    }
    Ok(received)
}

fn terminal_qr(text: &str) -> anyhow::Result<String> {
    Ok(QrCode::with_error_correction_level(text, EcLevel::L)
        .map_err(|error| anyhow::anyhow!("encoding the pairing QR: {error:?}"))?
        .render::<Dense1x2>()
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Command, DeviceCommand, parse};

    fn parse_pair(args: &[&str]) -> anyhow::Result<Command> {
        parse(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn pair_cli_parses_both_forms_and_defaults_to_ten_minutes() {
        assert!(matches!(
            parse_pair(&["pair"]).unwrap(),
            Command::Device(DeviceCommand::Pair { ttl_s: 600 })
        ));
        assert!(matches!(
            parse_pair(&["pair", "--ttl", "60"]).unwrap(),
            Command::Device(DeviceCommand::Pair { ttl_s: 60 })
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
    fn pair_targets_deduplicate_usable_addresses_with_space_for_tailscale() {
        let targets = bundle_targets(
            "",
            &interfaces(&[
                ("lo", "127.0.0.1"),
                ("eth0", "fe80::1"),
                ("tailscale0", "100.64.17.2"),
                ("eth0", "192.168.0.1"),
                ("eth0", "192.168.0.1"),
                ("eth1", "10.0.0.1"),
                ("eth2", "10.0.0.2"),
                ("eth3", "10.0.0.3"),
            ]),
        );
        assert_eq!(
            targets
                .iter()
                .map(|target| (target.route, target.host.as_str()))
                .collect::<Vec<_>>(),
            [
                (BundleRoute::Lan, "192.168.0.1"),
                (BundleRoute::Lan, "10.0.0.1"),
                (BundleRoute::Lan, "10.0.0.2"),
                (BundleRoute::Tailscale, "100.64.17.2"),
            ]
        );
        assert!(
            bundle_targets(
                "tower.local",
                &interfaces(&[("lo", "127.0.0.1"), ("lo", "::1")])
            )
            .is_empty()
        );
    }

    fn interfaces(entries: &[(&str, &str)]) -> Vec<(String, IpAddr)> {
        entries
            .iter()
            .map(|(name, addr)| ((*name).into(), addr.parse().expect("fixture interface IP")))
            .collect()
    }

    #[test]
    fn pair_preserves_the_hostname_and_physical_lan_on_a_host_with_virtual_routes() {
        let targets = bundle_targets(
            "tower.local",
            &interfaces(&[
                ("docker0", "172.17.0.1"),
                ("br-deadbeef", "10.0.9.1"),
                ("wg0", "10.0.9.2"),
                ("eth0", "100.90.2.1"),
                ("eth1", "10.1.2.3"),
                ("tailscale0", "100.64.0.1"),
            ]),
        );
        assert_eq!(
            targets
                .iter()
                .map(|target| (target.route, target.host.as_str()))
                .collect::<Vec<_>>(),
            [
                (BundleRoute::Lan, "tower.local"),
                (BundleRoute::Lan, "100.90.2.1"),
                (BundleRoute::Lan, "10.1.2.3"),
                (BundleRoute::Tailscale, "100.64.0.1"),
            ]
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

    #[test]
    fn pair_prints_an_ordinary_three_pin_qr_within_an_eighty_column_terminal() {
        let host = BundleHost {
            host_id: statglass_schema::HostId(uuid::Uuid::from_u128(456)),
            name: "workstation".into(),
            os: "linux".into(),
            user: "statglass".into(),
            port: None,
            targets: vec![
                BundleTarget {
                    route: BundleRoute::Lan,
                    host: "workstation.local".into(),
                },
                BundleTarget {
                    route: BundleRoute::Lan,
                    host: "192.168.1.40".into(),
                },
            ],
            host_keys: ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"]
                .into_iter()
                .map(|algorithm| BundleHostKey {
                    algorithm: algorithm.into(),
                    sha256: format!("SHA256:{}", "a".repeat(43)),
                })
                .collect(),
        };
        let offer = PairingPayload {
            version: 1,
            host,
            pairing_key: [245; 32],
            nonce: "0123456789abcdef0123456789abcdef".into(),
            code: "ABC234".into(),
            expires_ms: 1_800_000_060_000,
        };
        let qr = terminal_qr(&encode_payload(&offer)).unwrap();
        let width = qr.lines().map(|line| line.chars().count()).max().unwrap();
        assert!(width <= 80, "terminal QR is {width} columns wide");
    }

    #[tokio::test]
    async fn pair_keeps_serving_a_final_status_after_the_terminal_edit_reports_an_error() {
        let (shutdown, mut closed) = watch::channel(false);
        let (decided, outcome) = tokio::sync::oneshot::channel();
        let (polled, final_status) = tokio::sync::oneshot::channel();
        let server = async {
            outcome.await.unwrap();
            polled.send(()).unwrap();
            closed.changed().await.unwrap();
            Ok(())
        };
        let decision = async {
            decided.send(()).unwrap();
            Err(anyhow::anyhow!("temporary pairing line cleanup failure"))
        };
        let interrupt = async { final_status.await.ok() };
        let result = drive_offer(server, shutdown, interrupt, decision).await;
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("temporary pairing line cleanup failure")
        );
        assert!(*closed.borrow());
    }

    #[test]
    fn pair_version_parser_handles_openssh_package_versions() {
        assert_eq!(openssh_version("OpenSSH_7.6p1, OpenSSL 3.0"), Some((7, 6)));
        assert_eq!(
            openssh_version("OpenSSH_7.7p2 Debian-2, OpenSSL 3.0"),
            Some((7, 7))
        );
        assert_eq!(
            openssh_version("OpenSSH_10.1p1, LibreSSL 3.3.6"),
            Some((10, 1))
        );
        assert_eq!(openssh_version("Dropbear v2025.89"), None);
    }

    #[test]
    fn pair_socket_uses_xdg_runtime_or_the_home_state_directory() {
        let mut env = AgentEnv {
            home: Some(PathBuf::from("/home/me")),
            ..Default::default()
        };
        assert_eq!(
            pairing_directory(&env).unwrap(),
            Path::new("/home/me/.local/state/statglass")
        );
        env.xdg_runtime_dir = Some(PathBuf::from("/run/user/1000"));
        assert_eq!(
            pairing_directory(&env).unwrap(),
            Path::new("/run/user/1000/statglass")
        );
        assert!(pairing_directory(&AgentEnv::default()).is_err());
    }
}
