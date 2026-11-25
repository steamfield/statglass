//! A remote host's connection as clients see it: state, route, sync progress and the
//! typed cause of the last failure. The desktop adds its own fields (vitals, remote
//! runs, agent updates) on top of [`RemoteConnection`].

use serde::{Deserialize, Serialize};
use statglass_session::{
    ConnectionFailureKind, ConnectionStatus, IncompatibleSide as SessionSide, Route,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum IncompatibleSide {
    Host,
    App,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteState {
    Connecting,
    Connected,
    Offline,
    Disabled,
    Error,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteRoute {
    Lan,
    Tailscale,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSync {
    Idle,
    CatchingUp,
    Current,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteFailureKind {
    Unreachable,
    Timeout,
    Authentication,
    HostKey,
    AgentNotRunning,
    /// The other Mac answered SSH but its StatGlass app is not running.
    AppNotRunning,
    /// The other Mac's StatGlass has remote monitoring turned off.
    MonitoringOff,
    Incompatible,
    IdentityChanged,
    Protocol,
    NameNotResolved,
    Refused,
    NoRoute,
    LocalOffline,
    TailscaleDown,
    PhoneKeyUnavailable,
    Internal,
}
/// One configured route's cause from the last failed connection attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RemoteRouteFailure {
    pub route: RemoteRoute,
    pub kind: RemoteFailureKind,
}

/// The platform-neutral part of a remote host's status.
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct RemoteConnection {
    pub state: RemoteState,
    pub route: Option<RemoteRoute>,
    pub sync: RemoteSync,
    pub failure: Option<RemoteFailureKind>,
    pub incompatible_side: Option<IncompatibleSide>,
    pub message: Option<String>,
    /// Per-route causes of the last failure; empty while connected or when the failure
    /// was not specific to a route.
    pub route_failures: Vec<RemoteRouteFailure>,
}

/// What a source's [`ConnectionStatus`] says, in the clients' vocabulary.
pub fn connection_status(status: &ConnectionStatus) -> RemoteConnection {
    RemoteConnection {
        state: if status.connected {
            RemoteState::Connected
        } else if status.retrying {
            RemoteState::Connecting
        } else if status.error.is_some() {
            RemoteState::Error
        } else {
            RemoteState::Offline
        },
        route: status.route.map(map_route),
        sync: if status.history_error.is_some() {
            RemoteSync::Unavailable
        } else if status.catching_up {
            RemoteSync::CatchingUp
        } else if status.connected {
            RemoteSync::Current
        } else {
            RemoteSync::Idle
        },
        failure: status.failure_kind.map(map_failure_kind),
        incompatible_side: status.incompatible_side.map(|side| match side {
            SessionSide::Host => IncompatibleSide::Host,
            SessionSide::App => IncompatibleSide::App,
        }),
        message: status.error.clone().or_else(|| {
            status
                .connected
                .then(|| status.history_error.clone())
                .flatten()
        }),
        route_failures: status
            .route_failures
            .iter()
            .map(|failure| RemoteRouteFailure {
                route: map_route(failure.route),
                kind: map_failure_kind(failure.kind),
            })
            .collect(),
    }
}

fn map_route(route: Route) -> RemoteRoute {
    match route {
        Route::Lan => RemoteRoute::Lan,
        Route::Tailscale => RemoteRoute::Tailscale,
    }
}

fn map_failure_kind(kind: ConnectionFailureKind) -> RemoteFailureKind {
    use ConnectionFailureKind as K;
    match kind {
        K::Unreachable => RemoteFailureKind::Unreachable,
        K::Timeout => RemoteFailureKind::Timeout,
        K::Authentication => RemoteFailureKind::Authentication,
        K::HostKey => RemoteFailureKind::HostKey,
        K::AgentNotRunning => RemoteFailureKind::AgentNotRunning,
        K::AppNotRunning => RemoteFailureKind::AppNotRunning,
        K::MonitoringOff => RemoteFailureKind::MonitoringOff,
        K::Incompatible => RemoteFailureKind::Incompatible,
        K::IdentityChanged => RemoteFailureKind::IdentityChanged,
        K::Protocol => RemoteFailureKind::Protocol,
        K::NameNotResolved => RemoteFailureKind::NameNotResolved,
        K::Refused => RemoteFailureKind::Refused,
        K::NoRoute => RemoteFailureKind::NoRoute,
        K::LocalOffline => RemoteFailureKind::LocalOffline,
        K::TailscaleDown => RemoteFailureKind::TailscaleDown,
        K::PhoneKeyUnavailable => RemoteFailureKind::PhoneKeyUnavailable,
        K::Internal => RemoteFailureKind::Internal,
    }
}
