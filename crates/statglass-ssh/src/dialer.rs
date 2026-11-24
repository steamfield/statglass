//! The russh dialer: resolve, connect, check the pinned host key, authenticate through
//! the [`Signer`] and exec the endpoint's command on one session channel.
use crate::{
    Signer,
    signer::{AuthError, RusshSigner},
    stream::{SessionStream, SocketGuard},
};
use russh::{
    client,
    keys::{HashAlg, PublicKeyOrCertificate},
};
use statglass_session::{
    BoxFuture, DialFailure, DialedStream, Dialer, Endpoint, HandshakeFailure, PinnedHostKey,
    RemoteError, Result, Target, UnreachableKind,
};
use std::{io, sync::Arc, time::Duration};
use tokio::{
    net::{TcpStream, lookup_host},
    time::timeout,
};

// std has no ErrorKind for EHOSTDOWN on these platforms.
#[cfg(target_vendor = "apple")]
const HOST_DOWN_ERRNO: Option<i32> = Some(64);
#[cfg(target_os = "linux")]
const HOST_DOWN_ERRNO: Option<i32> = Some(112);
#[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
const HOST_DOWN_ERRNO: Option<i32> = None;

/// Timing for one russh connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RusshConfig {
    /// The limit for opening a command stream on one target.
    pub connect_timeout: Duration,
    /// How often an idle connection sends a keepalive.
    pub keepalive_interval: Duration,
    /// Unanswered keepalives before the connection counts as dead.
    pub keepalive_max: usize,
}

impl Default for RusshConfig {
    /// 5 s to connect, matching the desktop's `ConnectTimeout`; keepalive every 15 s
    /// with at most 3 misses, matching its `ServerAliveInterval`/`ServerAliveCountMax`.
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(5),
            keepalive_interval: Duration::from_secs(15),
            keepalive_max: 3,
        }
    }
}

/// Dials paired hosts in-process with russh.
pub struct RusshDialer {
    signer: Arc<dyn Signer>,
    config: RusshConfig,
}

impl RusshDialer {
    /// A dialer that signs with `signer` and uses the default [`RusshConfig`].
    pub fn new(signer: Arc<dyn Signer>) -> Self {
        Self::with_config(signer, RusshConfig::default())
    }

    pub fn with_config(signer: Arc<dyn Signer>, config: RusshConfig) -> Self {
        Self { signer, config }
    }

    async fn open(&self, endpoint: &Endpoint, host: &str) -> Result<DialedStream> {
        endpoint
            .validate()
            .map_err(|err| protocol_context(host, err))?;
        let user = endpoint
            .user
            .as_deref()
            .ok_or_else(|| RemoteError::Protocol(format!("{host}: an SSH user is required")))?;
        if endpoint.host_keys.is_empty() {
            return Err(RemoteError::Protocol(format!(
                "{host}: a paired SSH host key is required"
            )));
        }
        let command = endpoint
            .command
            .serve_command()
            .map_err(|err| protocol_context(host, err))?;
        let mut signer = RusshSigner(self.signer.as_ref());
        let key = signer
            .public_key()
            .map_err(|err| RemoteError::Authentication(format!("{host}: {err}")))?;
        let (socket, guard) = connect_tcp(host, endpoint.port.unwrap_or(22)).await?;
        let config = client::Config {
            keepalive_interval: Some(self.config.keepalive_interval),
            keepalive_max: self.config.keepalive_max,
            ..Default::default()
        };
        let handler = HostKeyCheck {
            host: host.into(),
            keys: endpoint.host_keys.clone(),
        };
        let mut session = client::connect_stream(Arc::new(config), socket, handler)
            .await
            .map_err(|err| match err {
                SessionError::HostKey(fp) => RemoteError::HostKey(format!(
                    "{host}: host key does not match the paired key ({fp})"
                )),
                SessionError::Ssh(error) => {
                    RemoteError::Transport(format!("{host}: SSH handshake: {error}"))
                }
            })?;
        let auth = session
            .authenticate_publickey_with(user, key, None, &mut signer)
            .await
            .map_err(|err| match err {
                AuthError::Signer(error) => RemoteError::Authentication(format!("{host}: {error}")),
                AuthError::Send(error) => {
                    RemoteError::Transport(format!("{host}: SSH authentication: {error}"))
                }
            })?;
        match auth {
            client::AuthResult::Success => {}
            // russh synthesizes an empty failure if its reply channel closes.
            client::AuthResult::Failure {
                remaining_methods,
                partial_success: false,
            } if remaining_methods.is_empty() && session.is_closed() => {
                return Err(RemoteError::Transport(format!(
                    "{host}: SSH connection closed during authentication"
                )));
            }
            client::AuthResult::Failure { .. } => {
                return Err(RemoteError::Authentication(format!(
                    "{host}: the host rejected the SSH key for {user}"
                )));
            }
        }
        let channel = session
            .channel_open_session()
            .await
            .map_err(|err| RemoteError::Transport(format!("{host}: open SSH channel: {err}")))?;
        SessionStream::open(session, channel, guard, command, host).await
    }
}

impl Dialer for RusshDialer {
    fn dial<'a>(
        &'a self,
        endpoint: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, Result<DialedStream>> {
        Box::pin(async {
            let host = &target.host;
            timeout(self.config.connect_timeout, self.open(endpoint, host))
                .await
                .map_err(|_| RemoteError::Timeout(format!("{host}: SSH connection timed out")))?
        })
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        let detail = if failure.stderr.is_empty() {
            failure.outcome.sentence()
        } else {
            failure.stderr
        };
        let message = format!("{}: {detail}", failure.target.host);
        match failure.outcome {
            HandshakeFailure::TimedOut => RemoteError::Timeout(message),
            _ => RemoteError::Transport(message),
        }
    }
}

fn protocol_context(host: &str, error: RemoteError) -> RemoteError {
    match error {
        RemoteError::Protocol(detail) => RemoteError::Protocol(format!("{host}: {detail}")),
        other => other,
    }
}

async fn connect_tcp(host: &str, port: u16) -> Result<(TcpStream, SocketGuard)> {
    // Tokio resolves names through getaddrinfo, so they can get NAT64 synthesis.
    // Numeric IPv4 literals bypass getaddrinfo and need an IPv4 route.
    let addresses: Vec<_> = lookup_host((host, port))
        .await
        .map_err(|err| RemoteError::Unreachable {
            kind: UnreachableKind::NameNotResolved,
            detail: format!("{host}: SSH name lookup: {err}"),
        })?
        .collect();
    if addresses.is_empty() {
        return Err(RemoteError::Unreachable {
            kind: UnreachableKind::NameNotResolved,
            detail: format!("{host}: SSH name lookup returned no addresses"),
        });
    }
    let socket = TcpStream::connect(addresses.as_slice())
        .await
        .map_err(|err| connect_error(host, &err))?;
    SocketGuard::new(socket)
        .map_err(|err| RemoteError::Transport(format!("{host}: configure SSH socket: {err}")))
}

fn connect_error(host: &str, error: &io::Error) -> RemoteError {
    let detail = format!("{host}: SSH connect: {error}");
    let kind = match error.kind() {
        io::ErrorKind::TimedOut => return RemoteError::Timeout(detail),
        io::ErrorKind::ConnectionRefused => UnreachableKind::Refused,
        io::ErrorKind::HostUnreachable | io::ErrorKind::NetworkUnreachable => {
            UnreachableKind::NoRoute
        }
        _ if HOST_DOWN_ERRNO.is_some_and(|errno| error.raw_os_error() == Some(errno)) => {
            UnreachableKind::NoRoute
        }
        _ => return RemoteError::Transport(detail),
    };
    RemoteError::Unreachable { kind, detail }
}

pub(crate) struct HostKeyCheck {
    host: String,
    keys: Vec<PinnedHostKey>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionError {
    #[error("host key does not match the paired key ({0})")]
    HostKey(String),
    #[error(transparent)]
    Ssh(#[from] russh::Error),
}

impl client::Handler for HostKeyCheck {
    type Error = SessionError;

    async fn check_server_key(
        &mut self,
        offered: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let key = offered.public_key();
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        if self
            .keys
            .iter()
            .any(|pin| pin.algorithm == key.algorithm().as_str() && pin.sha256 == fp)
        {
            Ok(true)
        } else {
            Err(SessionError::HostKey(fp))
        }
    }

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> std::result::Result<(), Self::Error> {
        tracing::debug!(host = %self.host, ?reason, "russh session ended");
        Ok(())
    }
}

#[cfg(test)]
mod tests;
