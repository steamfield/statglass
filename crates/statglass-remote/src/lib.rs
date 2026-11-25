#![cfg_attr(test, allow(clippy::too_many_lines))]
//! Persistent, direct SSH sessions. No network listener, collector, or Tauri dependency.
pub mod agent_install;
pub mod agent_layout;
mod calls;
mod clock;
mod codec;
pub mod control;
mod host_queries;
mod host_server;
pub mod install;
mod mirror;
mod mirror_error;
mod mirror_sink;
pub mod network;
pub mod rr;
pub use mirror_error::MirrorError;
mod pages;
pub use mirror::{AlertListener, Mirror, SyncWatermark};
mod server;
mod socket;
mod source;
mod stdio;
#[cfg(test)]
mod test_support;
mod transport;
pub mod trust;

pub use agent_layout::{AGENT_NOT_RUNNING, AgentEnv, AgentLayout, AgentPaths};
pub use clock::HostClock;
pub use host_server::{HostServer, InterestSet, ServedHost};
pub use mirror_sink::MirrorSink;
pub use pages::{page_from_wire, page_to_wire};
pub use server::status_to_wire;
pub use server::{
    ServerProvider, headline_metrics, headline_series, serve_connection, serve_metrics,
};
pub use socket::{
    ControlRequest, ControlResponse, SocketPaths, bind_private, control_request, same_uid,
    serve_control,
};
pub use source::{
    ConnectionFailureKind, ConnectionStatus, RemoteSource, RouteFailure, StatusCallback,
};
pub use statglass_proto::RemoteInterest;
pub use stdio::stdio_bridge;
pub use transport::{
    DIAL_TIMEOUT_MS, EndpointConfig, RemoteCommand, Route, SshSession, connect, ssh_command,
};

#[derive(Debug, thiserror::Error)]
pub enum RemoteError {
    #[error("{0}")]
    Transport(String),
    #[error("{0}")]
    Timeout(String),
    #[error("SSH authentication requires attention: {0}")]
    Authentication(String),
    #[error("SSH host-key verification requires attention: {0}")]
    HostKey(String),
    #[error("incompatible remote: {0}")]
    Incompatible(String),
    /// The peer's handshake could not be negotiated. Carries the version it reported,
    /// so the shell can still show it and offer the coordinated upgrade (D-119).
    #[error("incompatible remote: {reason}")]
    IncompatiblePeer { version: String, reason: String },
    #[error("remote host identity does not match: {0}")]
    Identity(String),
    /// The host answered with a different id than the one paired. Carries both, so the
    /// shell can offer to re-pair it as a new host (D-116).
    #[error(
        "remote host identity does not match: {alias} identified {actual}, expected {expected}"
    )]
    IdentityMismatch {
        alias: String,
        expected: statglass_schema::HostId,
        actual: statglass_schema::HostId,
    },
    /// The host has `statglass-agent` but its daemon is not running ([`AGENT_NOT_RUNNING`]).
    /// Retryable: the service manager restarts it.
    #[error("StatGlass agent is not running on {0}")]
    AgentNotRunning(String),
    #[error("invalid remote message: {0}")]
    Protocol(String),
    /// A query (D-117) the host is too busy or slow to answer now. Retryable.
    #[error("{0}")]
    Busy(String),
    /// A current host that does not answer this query (D-117): not offered there.
    #[error("{0}")]
    Unsupported(String),
    /// The source has no readable durable history.
    #[error("{0}")]
    HistoryUnavailable(String),
    /// Invalid query input or a stale continuation.
    #[error("{0}")]
    InvalidArgument(String),
    /// The host's own refusal of a query (D-117), worded for the user.
    #[error("{0}")]
    Refused(String),
    /// The host's state changed since the revision the request was based on
    /// (`ErrorCode::Stale`): reload and try again.
    #[error("{0}")]
    Stale(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Codec(#[from] statglass_proto::CodecError),
    /// SSH could not open a connection to the host; `kind` is what its stderr said.
    /// Retryable. `detail` keeps the alias-prefixed stderr for Technical details.
    #[error("{detail}")]
    Unreachable {
        kind: UnreachableKind,
        detail: String,
    },
    /// Both configured routes failed with retryable errors; each keeps its own cause.
    #[error("LAN: {lan}; Tailscale: {tailscale}")]
    BothRoutes {
        lan: Box<RemoteError>,
        tailscale: Box<RemoteError>,
    },
}
/// Why SSH could not open a connection, read from its stderr.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnreachableKind {
    /// The alias did not resolve ("Could not resolve hostname").
    NameNotResolved,
    /// Something answered on the address but refused port 22.
    Refused,
    /// The OS had no route ("No route to host", "Network is unreachable", "Host is down").
    NoRoute,
}
impl RemoteError {
    pub fn retryable(&self) -> bool {
        !matches!(
            self,
            Self::Authentication(_)
                | Self::HostKey(_)
                | Self::Incompatible(_)
                | Self::IncompatiblePeer { .. }
                | Self::Identity(_)
                | Self::IdentityMismatch { .. }
                | Self::Protocol(_)
                | Self::Unsupported(_)
                | Self::Refused(_)
                | Self::Stale(_)
                | Self::InvalidArgument(_)
        )
    }
}
pub type Result<T> = std::result::Result<T, RemoteError>;
