//! What the shell is told about a source's connection.
use crate::{RemoteError, Route};
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
}

impl ConnectionFailureKind {
    pub fn from_error(e: &RemoteError) -> Self {
        match e {
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
}
impl ConnectionStatus {
    pub(super) fn record_failure(&mut self, e: &RemoteError) {
        self.connected = false;
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
mod tests {
    use super::ConnectionFailureKind;

    #[test]
    fn an_incompatible_peer_keeps_its_version_until_it_reconnects() {
        let mut status = super::ConnectionStatus {
            remote_version: Some("0.2.0".into()),
            ..Default::default()
        };
        status.record_failure(&crate::RemoteError::IncompatiblePeer {
            version: "0.1.0".into(),
            reason: "protocol 1 is below 2".into(),
        });
        assert!(status.incompatible && !status.retrying);
        assert_eq!(
            status.failure_kind,
            Some(ConnectionFailureKind::Incompatible)
        );
        assert_eq!(status.remote_version.as_deref(), Some("0.1.0"));
        status.record_failure(&crate::RemoteError::Transport("offline".into()));
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
            status.record_failure(&error);
            assert_eq!(status.failure_kind, Some(kind));
            assert_eq!(status.retrying, retryable);
        }
    }
}
