//! The russh dialer: resolve, connect, check the pinned host key, authenticate through
//! the [`Signer`] and exec the endpoint's command on one session channel.
use crate::Signer;
use statglass_session::{
    BoxFuture, DialFailure, DialedStream, Dialer, Endpoint, RemoteError, Result, Target,
};
use std::{sync::Arc, time::Duration};

/// Timing for one russh connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RusshConfig {
    /// The limit for resolving, TCP connect and authentication on one target.
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
    #[expect(
        dead_code,
        reason = "the phase 2 russh lane authenticates with it in dial"
    )]
    signer: Arc<dyn Signer>,
    #[expect(dead_code, reason = "the phase 2 russh lane applies it in dial")]
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
}

impl Dialer for RusshDialer {
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
