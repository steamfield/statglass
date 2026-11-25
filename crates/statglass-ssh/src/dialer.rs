//! The russh dialer: resolve, connect, check the pinned host key, authenticate through
//! the [`Signer`] and exec the endpoint's command on one session channel.
use crate::{
    Signer, SignerError,
    signer::{AuthError, RusshSigner},
    stream::{SessionStream, SocketGuard},
};
use russh::{
    AlgorithmKind, Preferred, client,
    keys::{Algorithm, HashAlg, PublicKeyOrCertificate},
};
use statglass_session::{
    BoxFuture, DialFailure, DialedStream, Dialer, Endpoint, HandshakeFailure, PinnedHostKey,
    RemoteError, Result, Target, UnreachableKind,
};
use std::{future::Future, io, net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    net::{TcpStream, lookup_host},
    time::{Instant, timeout_at},
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

    async fn open(
        &self,
        endpoint: &Endpoint,
        host: &str,
        deadline: Instant,
    ) -> Result<DialedStream> {
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
        let point = self
            .signer
            .public_key()
            .await
            .map_err(|error| signer_failure(host, error))?;
        let mut signer = RusshSigner::new(self.signer.as_ref(), point).ok_or_else(|| {
            RemoteError::SignerInternal(format!(
                "{host}: the signing key's public key is not a 65-byte uncompressed P-256 point"
            ))
        })?;
        let key = signer.public_key();
        let handler = HostKeyCheck::new(host, &endpoint.host_keys)?;
        let config = client::Config {
            keepalive_interval: Some(self.config.keepalive_interval),
            keepalive_max: self.config.keepalive_max,
            preferred: Preferred {
                key: handler.preferred_algorithms().into(),
                ..Preferred::default()
            },
            ..Default::default()
        };
        let (socket, guard) = connect_tcp(host, endpoint.port.unwrap_or(22), deadline).await?;
        let mut session = client::connect_stream(Arc::new(config), socket, handler)
            .await
            .map_err(|err| err.into_remote(host))?;
        let auth = session
            .authenticate_publickey_with(user, key, None, &mut signer)
            .await
            .map_err(|err| match err {
                AuthError::Signer(error) => signer_failure(host, error),
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

fn signer_failure(host: &str, error: SignerError) -> RemoteError {
    let detail = format!("{host}: {error}");
    match error {
        SignerError::Unavailable(_) | SignerError::Refused(_) => {
            RemoteError::PhoneKeyUnavailable(detail)
        }
        SignerError::Invalid(_) | SignerError::Internal(_) => RemoteError::SignerInternal(detail),
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
            let deadline = Instant::now()
                .checked_add(self.config.connect_timeout)
                .ok_or_else(|| {
                    RemoteError::Protocol(format!(
                        "{host}: SSH connection timeout exceeds the supported range"
                    ))
                })?;
            timeout_at(deadline, self.open(endpoint, host, deadline))
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

async fn connect_tcp(host: &str, port: u16, deadline: Instant) -> Result<(TcpStream, SocketGuard)> {
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
    let socket = connect_addresses(host, &addresses, deadline, TcpStream::connect).await?;
    SocketGuard::new(socket)
        .map_err(|err| RemoteError::Transport(format!("{host}: configure SSH socket: {err}")))
}

async fn connect_addresses<F: Future<Output = io::Result<TcpStream>>>(
    host: &str,
    addresses: &[SocketAddr],
    deadline: Instant,
    mut connect: impl FnMut(SocketAddr) -> F,
) -> Result<TcpStream> {
    let mut best = RemoteError::Timeout(format!("{host}: SSH connection timed out"));
    for (index, &address) in addresses.iter().enumerate() {
        let now = Instant::now();
        let remaining = deadline.saturating_duration_since(now);
        if remaining.is_zero() {
            break;
        }
        let addresses_left = u32::try_from(addresses.len() - index).unwrap_or(u32::MAX);
        let share = (remaining / addresses_left)
            .max(Duration::from_secs(1))
            .min(remaining);
        match timeout_at(now + share, connect(address)).await {
            Ok(Ok(socket)) => return Ok(socket),
            Ok(Err(err)) => {
                let next = connect_error(host, &err);
                if connect_error_priority(&next) > connect_error_priority(&best) {
                    best = next;
                }
            }
            Err(_) => {}
        }
    }
    Err(best)
}

fn connect_error_priority(error: &RemoteError) -> u8 {
    match error {
        RemoteError::Unreachable {
            kind: UnreachableKind::Refused,
            ..
        } => 3,
        RemoteError::Unreachable {
            kind: UnreachableKind::NoRoute,
            ..
        } => 2,
        RemoteError::Transport(_) => 1,
        _ => 0,
    }
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
    keys: Vec<(Algorithm, String)>,
}

impl HostKeyCheck {
    fn new(host: &str, pins: &[PinnedHostKey]) -> Result<Self> {
        let keys = pins
            .iter()
            .map(|pin| {
                let algorithm = match Algorithm::new(&pin.algorithm) {
                    Ok(algorithm) if !matches!(algorithm, Algorithm::Other(_)) => algorithm,
                    _ => {
                        return Err(RemoteError::Protocol(format!(
                            "{host}: unknown pinned SSH host key algorithm {:?}",
                            pin.algorithm
                        )));
                    }
                };
                Ok((algorithm, pin.sha256.clone()))
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            host: host.into(),
            keys,
        })
    }

    fn preferred_algorithms(&self) -> Vec<Algorithm> {
        let mut preferred = Vec::new();
        for (algorithm, _) in &self.keys {
            if matches!(algorithm, Algorithm::Rsa { hash: None }) {
                // ssh-rsa identifies the key. Use SHA-2 signatures for that key.
                preferred.extend(
                    [HashAlg::Sha512, HashAlg::Sha256]
                        .map(|hash| Algorithm::Rsa { hash: Some(hash) }),
                );
            } else {
                preferred.push(algorithm.clone());
            }
        }
        preferred
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionError {
    #[error("host key does not match the paired key ({0})")]
    HostKey(String),
    #[error(transparent)]
    Ssh(#[from] russh::Error),
}

impl SessionError {
    fn into_remote(self, host: &str) -> RemoteError {
        match self {
            Self::HostKey(_) => RemoteError::HostKey(format!("{host}: {self}")),
            Self::Ssh(russh::Error::NoCommonAlgo {
                kind: AlgorithmKind::Key,
                ..
            }) => RemoteError::HostKey(format!(
                "{host}: the host did not offer a paired SSH host key algorithm"
            )),
            Self::Ssh(error) => RemoteError::Transport(format!("{host}: SSH handshake: {error}")),
        }
    }
}

impl client::Handler for HostKeyCheck {
    type Error = SessionError;

    async fn check_server_key(
        &mut self,
        offered: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let key = offered.public_key();
        let algorithm = key.algorithm();
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        if self.keys.iter().any(|(pinned, sha256)| {
            let same_family = pinned == &algorithm
                || matches!(
                    (pinned, &algorithm),
                    (Algorithm::Rsa { .. }, Algorithm::Rsa { .. })
                );
            same_family && sha256 == &fp
        }) {
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
