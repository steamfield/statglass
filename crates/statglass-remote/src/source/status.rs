//! What the shell is told about a source's connection.
use crate::network::{self, LocalNetwork};
use crate::{RemoteError, Route, UnreachableKind};
use serde::{Deserialize, Serialize};
use statglass_schema::HostId;

/// Typed classification of why the last remote connection attempt failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionFailureKind {
    Unreachable,
    Timeout,
    Authentication,
    HostKey,
    AgentNotRunning,
    Incompatible,
    IdentityChanged,
    Protocol,
    /// The alias did not resolve on the network this Mac is on.
    NameNotResolved,
    /// The host answered but refused SSH.
    Refused,
    /// This Mac had no route to the host.
    NoRoute,
    /// This Mac had no usable network when the attempt failed.
    LocalOffline,
    /// The failing route is Tailscale and Tailscale is not up on this Mac.
    TailscaleDown,
}

/// One configured route's failure from the last connection attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteFailure {
    pub route: Route,
    pub kind: ConnectionFailureKind,
}

impl ConnectionFailureKind {
    /// How actionable this cause is from this Mac; lower wins when two routes fail
    /// differently (local_offline, tailscale_down, agent_not_running, refused, timeout,
    /// no_route, name_not_resolved, unreachable, then the blocking kinds).
    pub fn priority(self) -> u8 {
        match self {
            Self::LocalOffline => 0,
            Self::TailscaleDown => 1,
            Self::AgentNotRunning => 2,
            Self::Refused => 3,
            Self::Timeout => 4,
            Self::NoRoute => 5,
            Self::NameNotResolved => 6,
            Self::Unreachable => 7,
            Self::Authentication => 8,
            Self::HostKey => 9,
            Self::Incompatible => 10,
            Self::IdentityChanged => 11,
            Self::Protocol => 12,
        }
    }

    /// Of two causes, the one with the lower [`priority`](Self::priority).
    fn most_actionable(self, other: Self) -> Self {
        if other.priority() < self.priority() {
            other
        } else {
            self
        }
    }

    /// The failure kind a connection error reports. Both failed routes report the more
    /// actionable of their two causes.
    pub fn from_error(e: &RemoteError) -> Self {
        match e {
            RemoteError::Unreachable { kind, .. } => Self::from_unreachable(*kind),
            RemoteError::BothRoutes { lan, tailscale } => {
                Self::from_error(lan).most_actionable(Self::from_error(tailscale))
            }
            RemoteError::Timeout(_) => Self::Timeout,
            RemoteError::Authentication(_) => Self::Authentication,
            RemoteError::HostKey(_) => Self::HostKey,
            RemoteError::AgentNotRunning(_) => Self::AgentNotRunning,
            RemoteError::Incompatible(_) | RemoteError::IncompatiblePeer { .. } => {
                Self::Incompatible
            }
            RemoteError::Identity(_) | RemoteError::IdentityMismatch { .. } => {
                Self::IdentityChanged
            }
            RemoteError::Protocol(_) | RemoteError::Codec(_) => Self::Protocol,
            RemoteError::Transport(_)
            | RemoteError::Io(_)
            | RemoteError::Busy(_)
            | RemoteError::Unsupported(_)
            | RemoteError::HistoryUnavailable(_)
            | RemoteError::InvalidArgument(_)
            | RemoteError::Refused(_) => Self::Unreachable,
        }
    }

    fn from_unreachable(kind: UnreachableKind) -> Self {
        match kind {
            UnreachableKind::NameNotResolved => Self::NameNotResolved,
            UnreachableKind::Refused => Self::Refused,
            UnreachableKind::NoRoute => Self::NoRoute,
        }
    }
}

/// Each route's cause in `e`: both routes when `e` combines them, the one route of a
/// single-route host, otherwise none.
fn route_failures_of(e: &RemoteError, single_route: Option<Route>) -> Vec<RouteFailure> {
    if let RemoteError::BothRoutes { lan, tailscale } = e {
        return vec![
            RouteFailure {
                route: Route::Lan,
                kind: ConnectionFailureKind::from_error(lan),
            },
            RouteFailure {
                route: Route::Tailscale,
                kind: ConnectionFailureKind::from_error(tailscale),
            },
        ];
    }
    single_route
        .map(|route| RouteFailure {
            route,
            kind: ConnectionFailureKind::from_error(e),
        })
        .into_iter()
        .collect()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub route: Option<Route>,
    pub retrying: bool,
    pub error: Option<String>,
    pub failure_kind: Option<ConnectionFailureKind>,
    pub history_error: Option<String>,
    pub last_seen_ms: Option<i64>,
    pub catching_up: bool,
    pub clock_offset_ms: i64,
    /// The connected peer's `Hello.app_version`, kept after it disconnects so the
    /// shell can offer an agent update while the host is offline.
    pub remote_version: Option<String>,
    /// The last attempt failed because the peer's protocol is incompatible
    /// ([`RemoteError::Incompatible`]); only a coordinated upgrade reconnects it.
    pub incompatible: bool,
    /// The id a host answered with when it is not the paired one
    /// ([`RemoteError::IdentityMismatch`]), so the shell can offer re-pairing.
    pub identity_changed: Option<HostId>,
    /// Per-route causes of the last failure: both routes for a dual-route host whose
    /// routes both failed, the one route for a single-route host, otherwise empty.
    pub route_failures: Vec<RouteFailure>,
    /// This Mac's wall-clock time of the next automatic attempt; `None` while dialing,
    /// connected, waiting for the network or waiting for a manual retry.
    pub next_attempt_ms: Option<i64>,
    /// Consecutive failed attempts since the last connection; 0 once connected.
    pub attempt: u32,
    /// A connection attempt is in flight.
    pub dialing: bool,
    /// This Mac is offline; the source waits for a network change instead of a timer.
    pub waiting_for_network: bool,
}
impl ConnectionStatus {
    /// Refines `failure_kind` and `route_failures` against this Mac's network at
    /// failure time (offline, Tailscale down).
    pub fn apply_network(&mut self, net: LocalNetwork) {
        for failure in &mut self.route_failures {
            failure.kind = network::refine(failure.kind, failure.route, net);
        }
        let refined_by_route = self
            .route_failures
            .iter()
            .map(|failure| failure.kind)
            .reduce(ConnectionFailureKind::most_actionable);
        if let Some(kind) = refined_by_route {
            self.failure_kind = Some(kind);
            return;
        }
        // Without a route to refine against, only "this Mac is offline" can be said, and
        // not over a refusal, which proves a host answered.
        if !net.online
            && let Some(kind) = self.failure_kind
            && network::is_network_kind(kind)
            && kind != ConnectionFailureKind::Refused
        {
            self.failure_kind = Some(ConnectionFailureKind::LocalOffline);
        }
    }

    /// Records a failed connection attempt. `single_route` is the host's only route, or
    /// `None` for a host with both routes configured.
    pub(super) fn record_failure(&mut self, e: &RemoteError, single_route: Option<Route>) {
        self.connected = false;
        self.route_failures = route_failures_of(e, single_route);
        self.error = Some(e.to_string());
        self.failure_kind = Some(ConnectionFailureKind::from_error(e));
        self.identity_changed = match e {
            RemoteError::IdentityMismatch { actual, .. } => Some(*actual),
            _ => None,
        };
        self.incompatible = matches!(
            e,
            RemoteError::Incompatible(_) | RemoteError::IncompatiblePeer { .. }
        );
        if let RemoteError::IncompatiblePeer { version, .. } = e {
            self.remote_version = Some(version.clone());
        }
        self.catching_up = false;
        self.retrying = e.retryable();
    }
}

#[cfg(test)]
mod network_tests;

#[cfg(test)]
mod tests {
    use super::ConnectionFailureKind;

    #[test]
    fn an_incompatible_peer_keeps_its_version_until_it_reconnects() {
        let mut status = super::ConnectionStatus {
            remote_version: Some("0.2.0".into()),
            ..Default::default()
        };
        status.record_failure(
            &crate::RemoteError::IncompatiblePeer {
                version: "0.1.0".into(),
                reason: "protocol 1 is below 2".into(),
            },
            None,
        );
        assert!(status.incompatible && !status.retrying);
        assert_eq!(
            status.failure_kind,
            Some(ConnectionFailureKind::Incompatible)
        );
        assert_eq!(status.remote_version.as_deref(), Some("0.1.0"));
        status.record_failure(&crate::RemoteError::Transport("offline".into()), None);
        assert!(!status.incompatible && status.retrying);
        assert_eq!(
            status.failure_kind,
            Some(ConnectionFailureKind::Unreachable)
        );
        assert_eq!(status.remote_version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn record_failure_maps_every_typed_variant() {
        let mut status = super::ConnectionStatus::default();
        let cases = [
            (
                crate::RemoteError::Timeout("timed out".into()),
                ConnectionFailureKind::Timeout,
                true,
            ),
            (
                crate::RemoteError::Authentication("denied".into()),
                ConnectionFailureKind::Authentication,
                false,
            ),
            (
                crate::RemoteError::HostKey("changed".into()),
                ConnectionFailureKind::HostKey,
                false,
            ),
            (
                crate::RemoteError::AgentNotRunning("server".into()),
                ConnectionFailureKind::AgentNotRunning,
                true,
            ),
            (
                crate::RemoteError::Identity("mismatch".into()),
                ConnectionFailureKind::IdentityChanged,
                false,
            ),
            (
                crate::RemoteError::Protocol("bad frame".into()),
                ConnectionFailureKind::Protocol,
                false,
            ),
        ];
        for (error, kind, retryable) in cases {
            status.record_failure(&error, None);
            assert_eq!(status.failure_kind, Some(kind));
            assert_eq!(status.retrying, retryable);
        }
    }
}
