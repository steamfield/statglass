//! Pairing an iPhone with this host (RFC `plan/rfc-ios-app.md` 2.4): the interactive
//! `pair` that shows a QR and asks for approval on this terminal, and the forced
//! `pair --nonce` the one-time pairing key runs.
use anyhow::{Context, ensure};
use qrcode::{EcLevel, QrCode, render::unicode::Dense1x2};
use statglass_proto::pairing::{
    BundleHost, BundleHostKey, BundleRoute, BundleTarget, PAIR_RECEIPT_GRACE, PairReply,
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
use tokio::signal::unix::{SignalKind, signal};
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
        let interrupt = pairing_interrupt().context("listening for terminal signals")?;
        let host = bundle(layout, &paths).await?;
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
        terminal_decision(pairing, payload, &pending, deadline),
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
    use rustix::process::{Pid, Signal as ProcessSignal, kill_process};
    use statglass_proto::pairing::{PairStart, decode_payload};
    use statglass_remote::{
        DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public, PairedDevice, control_request,
    };
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
