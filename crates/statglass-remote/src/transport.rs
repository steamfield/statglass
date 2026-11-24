use crate::{RemoteError, Result, Route, SshSession, UnreachableKind, codec};
use serde::{Deserialize, Serialize};
use statglass_schema::HostId;
pub(crate) use statglass_session::command::{helper_command, sh_c, sh_word, shell_quote};
use statglass_session::{
    BoxFuture, Close, DialFailure, DialedStream, Dialer, Endpoint, HandshakeFailure, RemoteCommand,
    STDERR_TAIL_BYTES, StderrTail, Target,
};
use std::{
    fs::File,
    io::{self, Read},
    os::fd::AsFd,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, ChildStderr, Command},
    sync::oneshot,
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
const SSH_PROGRAM: &str = "/usr/bin/ssh";
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

/// Dials through OpenSSH with the user's config and known_hosts.
#[derive(Clone, Debug)]
pub struct OpenSshDialer {
    program: PathBuf,
    config_file: Option<PathBuf>,
}

impl Default for OpenSshDialer {
    fn default() -> Self {
        Self {
            program: SSH_PROGRAM.into(),
            config_file: None,
        }
    }
}

impl OpenSshDialer {
    /// Use an alternate SSH config in place of the user's default config.
    pub fn with_config_file(path: impl Into<PathBuf>) -> Self {
        Self {
            config_file: Some(path.into()),
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn with_program(path: impl Into<PathBuf>) -> Self {
        Self {
            program: path.into(),
            ..Self::default()
        }
    }

    fn command(&self, endpoint: &Endpoint, target: &Target) -> Result<Command> {
        let mut command = ssh_command_base(&self.program, &target.host)?;
        if let Some(port) = endpoint.port {
            command.arg(format!("-oPort={port}"));
        }
        if let Some(user) = &endpoint.user {
            command.arg(format!("-oUser={user}"));
        }
        if let Some(path) = &self.config_file {
            command.arg("-F").arg(path);
        }
        command.args(["--", target.host.as_str()]);
        command.arg(endpoint.command.serve_command()?);
        Ok(command)
    }
}

impl Dialer for OpenSshDialer {
    fn dial<'a>(
        &'a self,
        endpoint: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, Result<DialedStream>> {
        Box::pin(async move {
            let mut child = self
                .command(endpoint, target)?
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            let reader = child
                .stdout
                .take()
                .ok_or_else(|| RemoteError::Transport("SSH stdout missing".into()))?;
            let writer = child
                .stdin
                .take()
                .ok_or_else(|| RemoteError::Transport("SSH stdin missing".into()))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| RemoteError::Transport("SSH stderr missing".into()))?;
            let captured = StderrTail::default();
            let (child_exited, exited) = oneshot::channel();
            let stderr_task =
                codec::AbortOnDrop(tokio::spawn(pump_stderr(stderr, captured.clone(), exited)));
            Ok(DialedStream {
                reader: Box::pin(reader),
                writer: Box::pin(writer),
                stderr: captured,
                close: Box::new(ChildClose {
                    child,
                    child_exited,
                    stderr_task,
                }),
            })
        })
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        let DialFailure {
            target,
            stderr,
            outcome,
        } = failure;
        let alias = &target.host;
        // SSH's own failures read the same at setup and on every later connection.
        let ssh = crate::install::setup_ssh_error(format!("{alias}: {stderr}"));
        let RemoteError::Transport(detail) = ssh else {
            return ssh;
        };
        if *outcome == HandshakeFailure::TimedOut || is_timeout_detail(stderr) {
            RemoteError::Timeout(if stderr.is_empty() {
                format!("{alias}: {}", outcome.sentence())
            } else {
                detail
            })
        } else if stderr.is_empty() {
            RemoteError::Transport(format!("{alias}: {}", outcome.sentence()))
        } else if let Some(kind) = unreachable_kind(stderr) {
            RemoteError::Unreachable { kind, detail }
        } else {
            RemoteError::Transport(detail)
        }
    }
}

/// An `ssh` child and its stderr pump. Dropping it kills the child (`kill_on_drop`);
/// `close` kills and reaps it.
struct ChildClose {
    child: Child,
    child_exited: oneshot::Sender<()>,
    stderr_task: codec::AbortOnDrop,
}

impl Close for ChildClose {
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let ChildClose {
                mut child,
                child_exited,
                mut stderr_task,
            } = *self;
            let _ = child.start_kill();
            if let Err(error) = child.wait().await {
                tracing::debug!(%error, "reaping SSH child");
            }
            let _ = child_exited.send(());
            if let Err(error) = (&mut stderr_task.0).await {
                tracing::debug!(%error, "joining SSH stderr pump");
            }
        })
    }
}

async fn pump_stderr(
    mut stderr: ChildStderr,
    output: StderrTail,
    mut child_exited: oneshot::Receiver<()>,
) {
    let mut buf = [0; 1024];
    loop {
        let read = tokio::select! {
            biased;
            exited = &mut child_exited => {
                if exited.is_ok()
                    && let Err(error) = drain_stderr(&stderr, &output)
                {
                    tracing::debug!(%error, "draining SSH stderr");
                }
                return;
            }
            read = stderr.read(&mut buf) => read,
        };
        match read {
            Ok(0) => return,
            Ok(n) => output.push(buf.get(..n).unwrap_or_default()),
            Err(error) => {
                tracing::debug!(%error, "reading SSH stderr");
                return;
            }
        }
    }
}

fn drain_stderr(stderr: &ChildStderr, output: &StderrTail) -> io::Result<()> {
    // A ProxyCommand can inherit the pipe. A duplicate preserves Tokio's nonblocking
    // flag and lets us read buffered bytes without waiting for readiness or EOF.
    let mut pipe = File::from(stderr.as_fd().try_clone_to_owned()?).take(STDERR_TAIL_BYTES as u64);
    let mut bytes = Vec::new();
    let result = pipe.read_to_end(&mut bytes);
    output.push(&bytes);
    match result {
        Err(error) if error.kind() != io::ErrorKind::WouldBlock => Err(error),
        _ => Ok(()),
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
    let mut command = ssh_command_base(Path::new(SSH_PROGRAM), alias)?;
    command.args(["--", alias]);
    Ok(command)
}

fn ssh_command_base(program: &Path, alias: &str) -> Result<Command> {
    validate_alias(alias)?;
    let mut command = Command::new(program);
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
    ]);
    command.kill_on_drop(true);
    Ok(command)
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

pub async fn connect(
    config: &EndpointConfig,
    local: HostId,
    expected: Option<HostId>,
) -> Result<SshSession> {
    config.validate()?;
    statglass_session::connect(
        &OpenSshDialer::default(),
        &config.endpoint(),
        local,
        expected,
    )
    .await
}

#[cfg(test)]
mod classify_tests;
#[cfg(test)]
mod openssh_tests;

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
