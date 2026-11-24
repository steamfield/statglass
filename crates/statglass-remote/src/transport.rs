use crate::{RemoteError, Result, Route, SshSession, UnreachableKind, codec};
use serde::{Deserialize, Serialize};
use statglass_proto::{Message, Offer};
use statglass_schema::HostId;
pub(crate) use statglass_session::command::{helper_command, sh_c, sh_word, shell_quote};
use statglass_session::{
    BoxFuture, Close, DialFailure, DialedStream, Dialer, Endpoint, HANDSHAKE_TIMEOUT,
    RemoteCommand, RouteError, StderrTail, Target,
};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndpointConfig {
    pub lan: Option<String>,
    pub tailscale: Option<String>,
    /// What the SSH session runs on the remote. `helper_path`, the field this replaced,
    /// still reads: a saved Mac host's path string is its [`RemoteCommand::MacHelper`].
    #[serde(default, alias = "helper_path")]
    pub command: RemoteCommand,
}

/// SSH's own limit for TCP connect and authentication on one route, 5 s.
const SSH_CONNECT_TIMEOUT_ARG: &str = "-oConnectTimeout=5";
impl EndpointConfig {
    pub fn validate(&self) -> Result<()> {
        if self.lan.is_none() && self.tailscale.is_none() {
            return Err(RemoteError::Protocol(
                "at least one SSH alias is required".into(),
            ));
        }
        for alias in [&self.lan, &self.tailscale].into_iter().flatten() {
            validate_alias(alias)?;
        }
        Ok(())
    }

    /// The host's only route, or `None` when both or neither alias is set.
    pub fn single_route(&self) -> Option<Route> {
        match (&self.lan, &self.tailscale) {
            (Some(_), None) => Some(Route::Lan),
            (None, Some(_)) => Some(Route::Tailscale),
            _ => None,
        }
    }

    /// The dialer endpoint: the LAN alias, then the Tailscale alias, as targets. Port,
    /// user and host keys come from the OpenSSH config and known_hosts.
    pub fn endpoint(&self) -> Endpoint {
        let routes = [(Route::Lan, &self.lan), (Route::Tailscale, &self.tailscale)];
        Endpoint {
            targets: routes
                .into_iter()
                .filter_map(|(route, alias)| {
                    alias.as_ref().map(|host| Target {
                        route,
                        host: host.clone(),
                    })
                })
                .collect(),
            port: None,
            user: None,
            host_keys: Vec::new(),
            command: self.command.clone(),
        }
    }
}

/// Dials through `/usr/bin/ssh` with the user's OpenSSH config and known_hosts.
#[derive(Clone, Debug, Default)]
pub struct OpenSshDialer;

impl Dialer for OpenSshDialer {
    fn dial<'a>(
        &'a self,
        _endpoint: &'a Endpoint,
        _target: &'a Target,
    ) -> BoxFuture<'a, Result<DialedStream>> {
        Box::pin(async { Err(RemoteError::Transport("not implemented".into())) })
    }

    fn classify(&self, _failure: &DialFailure<'_>) -> RemoteError {
        RemoteError::Transport("not implemented".into())
    }
}

/// An `ssh` child and its stderr pump. Dropping it kills the child (`kill_on_drop`);
/// `close` kills and reaps it.
struct ChildClose {
    child: Child,
    stderr_task: codec::AbortOnDrop,
}

impl Close for ChildClose {
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let ChildClose {
                mut child,
                stderr_task,
            } = *self;
            // Kill fails only when the child already exited; wait then reaps it.
            let _ = child.kill().await;
            let _ = child.wait().await;
            drop(stderr_task);
        })
    }
}
fn validate_alias(alias: &str) -> Result<()> {
    if alias.is_empty()
        || alias.starts_with('-')
        || alias.len() > 255
        || alias.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(RemoteError::Protocol("invalid SSH alias".into()));
    }
    Ok(())
}
/// A dedicated connection whose lifetime belongs entirely to StatGlass.
pub fn ssh_command(alias: &str) -> Result<Command> {
    validate_alias(alias)?;
    let mut command = Command::new("/usr/bin/ssh");
    command.args([
        "-T",
        "-oBatchMode=yes",
        "-oStrictHostKeyChecking=yes",
        SSH_CONNECT_TIMEOUT_ARG,
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
        "--",
        alias,
    ]);
    command.kill_on_drop(true);
    Ok(command)
}

async fn dial(
    alias: &str,
    route: Route,
    config: &EndpointConfig,
    local: HostId,
    expected: Option<HostId>,
) -> Result<SshSession> {
    let mut command = ssh_command(alias)?;
    command.arg(config.command.serve_command()?);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut reader = child
        .stdout
        .take()
        .ok_or_else(|| RemoteError::Transport("SSH stdout missing".into()))?;
    let mut writer = child
        .stdin
        .take()
        .ok_or_else(|| RemoteError::Transport("SSH stdin missing".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| RemoteError::Transport("SSH stderr missing".into()))?;
    let captured = StderrTail::default();
    let output = captured.clone();
    let task = codec::AbortOnDrop(tokio::spawn(async move {
        let mut buf = [0; 1024];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            output.push(buf.get(..n).unwrap_or_default());
        }
    }));
    // Counted from the spawn: ConnectTimeout ends a silent TCP connect sooner, and this
    // bounds the whole attempt, including the helper and the greeting.
    let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, codec::read(&mut reader)).await;
    let hello = match handshake {
        Ok(Ok(Message::Hello(h))) => *h,
        other => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            tokio::task::yield_now().await;
            let detail = captured.text();
            tracing::debug!(?other, %detail, "remote handshake failed");
            return Err(stderr_error(alias, detail, &other));
        }
    };
    if hello.host.id == local {
        return Err(RemoteError::Identity(
            "cannot connect this Mac to itself".into(),
        ));
    }
    if let Some(expected) = expected
        && expected != hello.host.id
    {
        return Err(RemoteError::IdentityMismatch {
            alias: alias.to_string(),
            expected,
            actual: hello.host.id,
        });
    }
    let negotiated = statglass_proto::negotiate(
        &Offer::local(statglass_proto::local_features()),
        &Offer::from(&hello),
    )
    .map_err(|e| RemoteError::IncompatiblePeer {
        version: hello.app_version.clone(),
        reason: e.to_string(),
    })?;
    codec::write(&mut writer, &Message::HelloAck(negotiated.ack())).await?;
    let target = Target {
        route,
        host: alias.to_string(),
    };
    let stream = DialedStream {
        reader: Box::pin(reader),
        writer: Box::pin(writer),
        stderr: captured,
        close: Box::new(ChildClose {
            child,
            stderr_task: task,
        }),
    };
    Ok(SshSession::new(hello, negotiated, target, stream))
}

/// The error for a session that ended before its `Hello`, from the remote's stderr.
fn stderr_error(
    alias: &str,
    detail: String,
    outcome: &std::result::Result<Result<Message>, tokio::time::error::Elapsed>,
) -> RemoteError {
    // SSH's own failures read the same at setup and on every later connection.
    let ssh = crate::install::setup_ssh_error(format!("{alias}: {detail}"));
    if !matches!(ssh, RemoteError::Transport(_)) {
        ssh
    } else if detail
        .lines()
        .any(|line| line.trim() == crate::AGENT_NOT_RUNNING)
    {
        RemoteError::AgentNotRunning(alias.to_string())
    } else if outcome.is_err() {
        let message = if detail.is_empty() {
            format!("{alias}: {}", handshake_failure(outcome))
        } else {
            format!("{alias}: {detail}")
        };
        RemoteError::Timeout(message)
    } else if is_timeout_detail(&detail) {
        RemoteError::Timeout(format!("{alias}: {detail}"))
    } else if detail.is_empty() {
        RemoteError::Transport(format!("{alias}: {}", handshake_failure(outcome)))
    } else if let Some(kind) = unreachable_kind(&detail) {
        RemoteError::Unreachable {
            kind,
            detail: format!("{alias}: {detail}"),
        }
    } else {
        RemoteError::Transport(format!("{alias}: {detail}"))
    }
}

/// Why SSH could not open a connection, from the first stderr line that says so.
fn unreachable_kind(detail: &str) -> Option<UnreachableKind> {
    detail.lines().find_map(|line| {
        let line = line.to_ascii_lowercase();
        if line.contains("could not resolve hostname") {
            Some(UnreachableKind::NameNotResolved)
        } else if line.contains("connection refused") {
            Some(UnreachableKind::Refused)
        } else if ["no route to host", "network is unreachable", "host is down"]
            .iter()
            .any(|marker| line.contains(marker))
        {
            Some(UnreachableKind::NoRoute)
        } else {
            None
        }
    })
}

fn is_timeout_detail(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("operation timed out")
        || lower.contains("connection timed out")
        || lower.contains("timed out")
}

fn handshake_failure(
    outcome: &std::result::Result<Result<Message>, tokio::time::error::Elapsed>,
) -> &'static str {
    match outcome {
        Err(_) => "The host did not answer in time.",
        Ok(Err(RemoteError::Io(error))) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            "The connection closed before StatGlass could start on the host."
        }
        Ok(Err(RemoteError::Io(_))) => {
            "The connection failed while StatGlass was starting on the host."
        }
        Ok(Err(_)) => "The host sent an invalid StatGlass greeting.",
        Ok(Ok(_)) => "The host did not send a StatGlass greeting.",
    }
}

/// Concurrent routes with a bounded preference grace. Futures own SSH children and
/// cancellation kills losers (Tokio's process reaper collects their exit status).
pub async fn connect(
    config: &EndpointConfig,
    local: HostId,
    expected: Option<HostId>,
) -> Result<SshSession> {
    config.validate()?;
    match (&config.lan, &config.tailscale) {
        (Some(lan), Some(tail)) => {
            race_routes(
                dial(lan, Route::Lan, config, local, expected),
                dial(tail, Route::Tailscale, config, local, expected),
                Duration::from_millis(500),
                |s: &SshSession| s.hello.host.id,
            )
            .await
        }
        (Some(alias), None) => dial(alias, Route::Lan, config, local, expected).await,
        (None, Some(alias)) => dial(alias, Route::Tailscale, config, local, expected).await,
        _ => Err(RemoteError::Protocol("no endpoints".into())),
    }
}
async fn race_routes<T, A, B, F>(lan: A, tail: B, grace: Duration, identity: F) -> Result<T>
where
    A: std::future::Future<Output = Result<T>>,
    B: std::future::Future<Output = Result<T>>,
    F: Fn(&T) -> HostId,
{
    let mut a = Box::pin(lan);
    let mut b = Box::pin(tail);
    tokio::select! {
        first=&mut a=>match first {Ok(s)=>Ok(s),Err(e)=>match b.await {Ok(s) if e.retryable()=>Ok(s),Ok(_)=>Err(e),Err(other)=>Err(combine(e,other))}},
        first=&mut b=>match first {
            Err(e)=>match a.await {Ok(s) if e.retryable()=>Ok(s),Ok(_)=>Err(e),Err(other)=>Err(combine(other,e))},
            Ok(tail)=>match tokio::time::timeout(grace,&mut a).await {
                Ok(Ok(lan))=>if identity(&lan)==identity(&tail){Ok(lan)}else{Err(RemoteError::Identity("LAN and Tailscale identify different Macs".into()))},
                Ok(Err(e)) if !e.retryable()=>Err(e),
                _=>Ok(tail),
            }
        }
    }
}

/// One error for a dual-route host whose LAN (`a`) and Tailscale (`b`) dials both
/// failed. A non-retryable side wins alone, a stopped agent on either side reads as
/// [`RemoteError::AgentNotRunning`], and otherwise both causes are kept in
/// [`RemoteError::Routes`]. The aliases are not threaded through this race, so each
/// [`RouteError::host`] is empty; the N-target race in `statglass_session` fills it.
fn combine(a: RemoteError, b: RemoteError) -> RemoteError {
    if !a.retryable() {
        return a;
    }
    if !b.retryable() {
        return b;
    }
    if matches!(a, RemoteError::AgentNotRunning(_)) || matches!(b, RemoteError::AgentNotRunning(_))
    {
        return RemoteError::AgentNotRunning(format!("LAN: {a}; Tailscale: {b}"));
    }
    RemoteError::Routes(vec![
        RouteError {
            route: Route::Lan,
            host: String::new(),
            error: a,
        },
        RouteError {
            route: Route::Tailscale,
            host: String::new(),
            error: b,
        },
    ])
}

#[cfg(test)]
mod classify_tests;

#[cfg(test)]
#[test]
fn the_dial_limit_covers_the_ssh_connect_limit() {
    let connect_secs: i64 = SSH_CONNECT_TIMEOUT_ARG
        .trim_start_matches("-oConnectTimeout=")
        .parse()
        .unwrap();
    assert!(connect_secs * 1000 < crate::DIAL_TIMEOUT_MS);
    assert_eq!(crate::DIAL_TIMEOUT_MS, 10_000);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn handshake_failures_use_plain_sentences() {
        let timeout = tokio::time::timeout(
            Duration::from_secs(1),
            std::future::pending::<Result<Message>>(),
        )
        .await;
        assert_eq!(
            handshake_failure(&timeout),
            "The host did not answer in time."
        );
        let eof = Ok(Err(RemoteError::Io(
            std::io::ErrorKind::UnexpectedEof.into(),
        )));
        assert_eq!(
            handshake_failure(&eof),
            "The connection closed before StatGlass could start on the host."
        );
        let io = Ok(Err(RemoteError::Io(
            std::io::ErrorKind::ConnectionReset.into(),
        )));
        assert_eq!(
            handshake_failure(&io),
            "The connection failed while StatGlass was starting on the host."
        );
        let invalid = Ok(Err(RemoteError::Protocol("bad frame".into())));
        assert_eq!(
            handshake_failure(&invalid),
            "The host sent an invalid StatGlass greeting."
        );
        assert_eq!(
            handshake_failure(&Ok(Ok(Message::Unknown))),
            "The host did not send a StatGlass greeting."
        );
    }

    #[tokio::test(start_paused = true)]
    async fn timeouts_and_dual_route_combine_preserve_failure_kind() {
        let timeout = tokio::time::timeout(
            Duration::from_secs(1),
            std::future::pending::<Result<Message>>(),
        )
        .await;
        let eof = Ok(Err(RemoteError::Io(
            std::io::ErrorKind::UnexpectedEof.into(),
        )));
        // Handshake timeout stays Timeout even with non-fatal SSH stderr banner text.
        assert!(matches!(
            stderr_error("m4-mini", "Warning: Permanently added".into(), &timeout),
            RemoteError::Timeout(msg) if msg.starts_with("m4-mini: ")
        ));
        // SSH connect timeout in stderr classifies as Timeout.
        assert!(matches!(
            stderr_error(
                "m4-mini",
                "ssh: connect to host m4-mini port 22: Operation timed out".into(),
                &eof,
            ),
            RemoteError::Timeout(msg) if msg.contains("Operation timed out")
        ));
        // Dual-route combine keeps AgentNotRunning, otherwise both causes.
        assert!(matches!(
            combine(
                RemoteError::Transport("dns failed".into()),
                RemoteError::Timeout("Operation timed out".into()),
            ),
            RemoteError::Routes(_)
        ));
        assert!(matches!(
            combine(
                RemoteError::Timeout("timed out".into()),
                RemoteError::AgentNotRunning("server".into()),
            ),
            RemoteError::AgentNotRunning(msg) if msg.contains("LAN:") && msg.contains("Tailscale:")
        ));
    }
    #[test]
    fn agent_marker_on_stderr_is_a_typed_not_running_error() {
        let eof = Ok(Err(RemoteError::Io(
            std::io::ErrorKind::UnexpectedEof.into(),
        )));
        let error = stderr_error("server", "statglass-agent: not running".into(), &eof);
        assert!(matches!(&error, RemoteError::AgentNotRunning(alias) if alias == "server"));
        assert!(error.retryable());
        // Among other login noise, still recognised; a mention in other text is not.
        let noisy = "Warning: Permanently added\nstatglass-agent: not running\n".to_string();
        assert!(matches!(
            stderr_error("server", noisy, &eof),
            RemoteError::AgentNotRunning(_)
        ));
        assert!(matches!(
            stderr_error("server", "sh: statglass-agent: not found".into(), &eof),
            RemoteError::Transport(_)
        ));
        assert!(matches!(
            stderr_error("server", String::new(), &eof),
            RemoteError::Transport(text) if text.contains("closed before")
        ));
    }
    /// A changed host key found on a later connection gets the host-key advice the
    /// setup flow gives, not "could not sign in".
    #[test]
    fn ssh_failures_classify_as_they_do_at_setup() {
        let eof = Ok(Err(RemoteError::Io(
            std::io::ErrorKind::UnexpectedEof.into(),
        )));
        let changed = "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.";
        assert!(matches!(
            stderr_error("server", changed.into(), &eof),
            RemoteError::HostKey(text) if text.starts_with("server: ")
        ));
        assert!(matches!(
            stderr_error(
                "server",
                "user@server: Permission denied (publickey).".into(),
                &eof
            ),
            RemoteError::Authentication(_)
        ));
    }
    #[tokio::test]
    async fn prefers_lan_within_grace_and_drops_loser() {
        let drops = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        struct Peer {
            route: Route,
            drops: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        }
        impl Drop for Peer {
            fn drop(&mut self) {
                self.drops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let a = drops.clone();
        let b = drops.clone();
        let selected = race_routes(
            async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok(Peer {
                    route: Route::Lan,
                    drops: a,
                })
            },
            async move {
                Ok(Peer {
                    route: Route::Tailscale,
                    drops: b,
                })
            },
            Duration::from_millis(50),
            |_| HostId(uuid::Uuid::nil()),
        )
        .await
        .unwrap();
        assert_eq!(selected.route, Route::Lan);
        assert_eq!(drops.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[tokio::test(start_paused = true)]
    async fn dead_lan_does_not_delay_tailscale_until_timeout() {
        let start = tokio::time::Instant::now();
        let selected = race_routes(
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(Route::Lan)
            },
            async { Ok(Route::Tailscale) },
            Duration::from_millis(20),
            |_| HostId(uuid::Uuid::nil()),
        )
        .await
        .unwrap();
        assert_eq!(selected, Route::Tailscale);
        assert_eq!(start.elapsed(), Duration::from_millis(20));
    }
    #[tokio::test]
    async fn mismatching_routes_are_rejected() {
        let selected = race_routes(
            async {
                tokio::time::sleep(Duration::from_millis(5)).await;
                Ok(HostId(uuid::Uuid::from_u128(1)))
            },
            async { Ok(HostId(uuid::Uuid::from_u128(2))) },
            Duration::from_millis(50),
            |id| *id,
        )
        .await;
        assert!(matches!(selected, Err(RemoteError::Identity(_))));
    }
    #[tokio::test]
    async fn all_failed_routes_report_both_errors() {
        let result = race_routes::<Route, _, _, _>(
            async { Err(RemoteError::Transport("local unavailable".into())) },
            async { Err(RemoteError::Transport("vpn unavailable".into())) },
            Duration::from_millis(1),
            |_| HostId(uuid::Uuid::nil()),
        )
        .await;
        let text = result.unwrap_err().to_string();
        assert!(text.contains("local unavailable"));
        assert!(text.contains("vpn unavailable"));
    }
    #[test]
    fn ssh_disables_shared_connections_and_interactive_auth() {
        let c = ssh_command("my-mac").unwrap();
        let args: Vec<_> = c
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"-oControlPath=none".into()));
        assert!(args.contains(&"-oStrictHostKeyChecking=yes".into()));
        assert!(ssh_command("-oProxyCommand=evil").is_err());
    }

    /// `remote-hosts.json` as the shell writes it today: the endpoint's fields are the
    /// config's aliases plus the top-level `helper_path`.
    const SAVED_HOST: &str = r#"{
      "config": {"id": "6f1c1b7e-0a43-4c47-9d7e-0d5f7f1b2a10", "name": "Studio",
                 "lan": "studio", "tailscale": "studio-ts", "enabled": true,
                 "mirror_budget_mb": 150},
      "record": {"id": "6f1c1b7e-0a43-4c47-9d7e-0d5f7f1b2a10", "is_local": false},
      "helper_path": "/Users/a/Applications/StatGlass.app/Contents/MacOS/statglass-remote-helper"
    }"#;

    #[test]
    fn old_saved_hosts_read_as_the_mac_helper() {
        let saved: serde_json::Value = serde_json::from_str(SAVED_HOST).unwrap();
        let old = serde_json::json!({
            "lan": saved["config"]["lan"],
            "tailscale": saved["config"]["tailscale"],
            "helper_path": saved["helper_path"],
        });
        let config: EndpointConfig = serde_json::from_value(old).unwrap();
        let helper = "/Users/a/Applications/StatGlass.app/Contents/MacOS/statglass-remote-helper";
        assert_eq!(config.command, RemoteCommand::MacHelper(helper.into()));
        assert_eq!(config.lan.as_deref(), Some("studio"));
        // The same top-level key also reads as a `command` on its own, so a saved host
        // can rename its field with `#[serde(alias = "helper_path")]`.
        let command: RemoteCommand = serde_json::from_value(saved["helper_path"].clone()).unwrap();
        assert_eq!(command, config.command);
        // An endpoint written before helper_path existed is the default installation.
        let bare: EndpointConfig =
            serde_json::from_str(r#"{"lan": "a", "tailscale": null}"#).unwrap();
        assert_eq!(bare.command, RemoteCommand::MacHelper(String::new()));
        // Both shapes round-trip.
        for command in [
            config.command.clone(),
            RemoteCommand::Agent {
                bin: "/usr/local/bin/statglass-agent".into(),
                system: true,
                socket: None,
            },
            RemoteCommand::Agent {
                bin: "/home/a/.local/bin/statglass-agent".into(),
                system: false,
                socket: Some("/run/user/1000/statglass-agent/metrics.sock".into()),
            },
        ] {
            let endpoint = EndpointConfig {
                lan: Some("a".into()),
                tailscale: None,
                command,
            };
            let text = serde_json::to_string(&endpoint).unwrap();
            assert_eq!(
                serde_json::from_str::<EndpointConfig>(&text).unwrap(),
                endpoint
            );
        }
    }
}
