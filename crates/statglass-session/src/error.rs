//! The errors a remote session reports, shared by every dialer and by the shell that
//! maps them to its command errors.
use crate::Route;

#[derive(Debug, thiserror::Error)]
pub enum RemoteError {
    #[error("{0}")]
    Transport(String),
    #[error("{0}")]
    Timeout(String),
    #[error("SSH authentication requires attention: {0}")]
    Authentication(String),
    /// The local phone key could not be read or used. Retry after it becomes available.
    #[error("{0}")]
    PhoneKeyUnavailable(String),
    /// The local signer returned an invalid key or signature or its callback failed.
    #[error("{0}")]
    SignerInternal(String),
    #[error("SSH host-key verification requires attention: {0}")]
    HostKey(String),
    #[error("incompatible remote: {0}")]
    Incompatible(String),
    /// The peer's handshake could not be negotiated. Carries the version it reported,
    /// so the shell can still show it and offer the coordinated upgrade (D-119).
    #[error("incompatible remote: {reason}")]
    IncompatiblePeer {
        version: String,
        reason: String,
        side: Option<crate::IncompatibleSide>,
    },
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
    /// The host has `statglass-agent` but its daemon is not running
    /// ([`AGENT_NOT_RUNNING`](crate::AGENT_NOT_RUNNING)). Retryable: the service manager
    /// restarts it.
    #[error("StatGlass agent is not running on {0}")]
    AgentNotRunning(String),
    /// The other Mac answered SSH but its StatGlass app is not running
    /// ([`APP_NOT_RUNNING`](crate::APP_NOT_RUNNING)). Retryable: the app may be opened.
    #[error("StatGlass isn't running on {0}")]
    AppNotRunning(String),
    /// The other Mac's StatGlass has remote monitoring turned off
    /// ([`MONITORING_OFF`](crate::MONITORING_OFF)). Retryable: the setting may be turned on.
    #[error("Remote monitoring is off on {0}")]
    MonitoringOff(String),
    /// Tailscale SSH answered on the host's Tailscale address instead of OpenSSH. It
    /// skips `authorized_keys`, so the phone's forced command never runs there. Retryable:
    /// the host may turn it off (`tailscale set --ssh=false`), and another route may work.
    #[error("Tailscale SSH answered on {0} instead of OpenSSH")]
    TailscaleSsh(String),
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
    /// The host failed internally while answering a query.
    #[error("{0}")]
    Internal(String),
    /// The host's state changed since the revision the request was based on
    /// (`ErrorCode::Stale`): reload and try again.
    #[error("{0}")]
    Stale(String),
    #[error(transparent)]
    Pairing(#[from] PairingRefusal),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Codec(#[from] statglass_proto::CodecError),
    /// The dialer could not open a connection to the host; `kind` says why. Retryable.
    /// `detail` keeps the host-prefixed cause for Technical details.
    #[error("{detail}")]
    Unreachable {
        kind: UnreachableKind,
        detail: String,
    },
    /// Every target of a multi-target endpoint failed with a retryable error, in target
    /// order; each keeps its own cause.
    #[error("{}", join_routes(.0))]
    Routes(Vec<RouteError>),
}

/// The host refused a pairing or the offer expired before the exchange finished.
#[derive(Debug, thiserror::Error)]
pub enum PairingRefusal {
    #[error("The host declined the pairing request")]
    Denied,
    #[error("The pairing code expired")]
    Expired,
    #[error("{0}")]
    Rejected(statglass_proto::pairing::PairError),
}

/// One target's failure inside [`RemoteError::Routes`].
#[derive(Debug)]
pub struct RouteError {
    pub route: Route,
    /// The target's host as dialed (an alias, DNS name or address literal).
    pub host: String,
    pub error: RemoteError,
}

/// Why a dialer could not open a connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnreachableKind {
    /// The host name did not resolve ("Could not resolve hostname").
    NameNotResolved,
    /// Something answered on the address but refused the SSH port.
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
                | Self::Internal(_)
                | Self::Stale(_)
                | Self::Pairing(_)
                | Self::InvalidArgument(_)
        )
    }
}

/// `"LAN: a; Tailscale: b"`: each target's route and cause, in target order.
fn join_routes(routes: &[RouteError]) -> String {
    routes
        .iter()
        .map(|failure| format!("{}: {}", failure.route, failure.error))
        .collect::<Vec<_>>()
        .join("; ")
}

pub type Result<T> = std::result::Result<T, RemoteError>;

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(route: Route, text: &str) -> RouteError {
        RouteError {
            route,
            host: "studio".into(),
            error: RemoteError::Transport(text.into()),
        }
    }

    #[test]
    fn routes_read_as_each_route_and_its_cause_in_target_order() {
        let both = RemoteError::Routes(vec![
            failure(Route::Lan, "a"),
            failure(Route::Tailscale, "b"),
        ]);
        assert_eq!(both.to_string(), "LAN: a; Tailscale: b");
        assert!(both.retryable());
        let three = RemoteError::Routes(vec![
            failure(Route::Lan, "a"),
            failure(Route::Tailscale, "b"),
            failure(Route::Tailscale, "c"),
        ]);
        assert_eq!(three.to_string(), "LAN: a; Tailscale: b; Tailscale: c");
    }
}
