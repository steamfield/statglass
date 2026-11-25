//! How a remote session's failure reaches a command: one `CommandError` kind per thing
//! the UI can act on (sign in again, trust the host key, start the app on the other Mac).
use super::{CommandError, HistoryUnavailableReason};
use serde::Serialize;
use statglass_session::{
    RemoteError,
    pairing::{PairError, PairingRefusal},
};

/// Why a pairing request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PairingFailure {
    Denied,
    Expired,
    Used,
    Unknown,
    Unavailable,
    Invalid,
}

impl From<PairError> for PairingFailure {
    fn from(error: PairError) -> Self {
        match error {
            PairError::Used => Self::Used,
            PairError::Unknown => Self::Unknown,
            PairError::Unavailable => Self::Unavailable,
            PairError::Invalid => Self::Invalid,
        }
    }
}

impl From<RemoteError> for CommandError {
    fn from(error: RemoteError) -> Self {
        let message = error.to_string();
        match error {
            RemoteError::Authentication(_) => Self::RemoteAuth { message },
            RemoteError::HostKey(_) => Self::HostKeyUnknown { message },
            RemoteError::Incompatible(_) | RemoteError::IncompatiblePeer { .. } => {
                Self::RemoteIncompatible { message }
            }
            RemoteError::Identity(_) | RemoteError::IdentityMismatch { .. } => {
                Self::RemoteIdentity { message }
            }
            RemoteError::AgentNotRunning(_) => Self::RemoteAgentNotRunning { message },
            RemoteError::AppNotRunning(_) => Self::RemoteNotRunning { message },
            RemoteError::MonitoringOff(_) => Self::RemoteMonitoringOff { message },
            RemoteError::Busy(_) => Self::RemoteBusy { message },
            RemoteError::Unsupported(_) => Self::RemoteUnsupported { message },
            // The host's own text says why (its database is damaged, or it has no store).
            RemoteError::HistoryUnavailable(message) => Self::HistoryUnavailable {
                reason: Some(HistoryUnavailableReason::Failed { message }),
            },
            RemoteError::InvalidArgument(_) => Self::InvalidArgument { message },
            RemoteError::Stale(_) => Self::RemoteRulesChanged { message },
            RemoteError::Refused(_) => Self::Internal { message },
            RemoteError::Pairing(refusal) => Self::Pairing {
                reason: match refusal {
                    PairingRefusal::Denied => PairingFailure::Denied,
                    PairingRefusal::Expired => PairingFailure::Expired,
                    PairingRefusal::Rejected(error) => error.into(),
                },
                message,
            },
            RemoteError::Transport(_)
            | RemoteError::Timeout(_)
            | RemoteError::Unreachable { .. }
            | RemoteError::Routes(_)
            | RemoteError::Io(_)
            | RemoteError::Codec(_)
            | RemoteError::Protocol(_) => Self::RemoteUnreachable { message },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_refusals_keep_their_reason_and_message_in_command_errors() {
        for (refusal, reason, serialized) in [
            (PairingRefusal::Denied, PairingFailure::Denied, "denied"),
            (PairingRefusal::Expired, PairingFailure::Expired, "expired"),
            (
                PairingRefusal::Rejected(PairError::Used),
                PairingFailure::Used,
                "used",
            ),
            (
                PairingRefusal::Rejected(PairError::Unknown),
                PairingFailure::Unknown,
                "unknown",
            ),
            (
                PairingRefusal::Rejected(PairError::Unavailable),
                PairingFailure::Unavailable,
                "unavailable",
            ),
            (
                PairingRefusal::Rejected(PairError::Invalid),
                PairingFailure::Invalid,
                "invalid",
            ),
        ] {
            let error = RemoteError::Pairing(refusal);
            let message = error.to_string();
            let command = CommandError::from(error);
            assert_eq!(
                command,
                CommandError::Pairing {
                    reason,
                    message: message.clone()
                }
            );
            assert_eq!(
                serde_json::to_value(command).unwrap(),
                serde_json::json!({"kind": "pairing", "reason": serialized, "message": message}),
            );
        }
    }
}
