//! How a remote session's failure reaches a command: one `CommandError` kind per thing
//! the UI can act on (sign in again, trust the host key, start the app on the other Mac).
use super::{CommandError, HistoryUnavailableReason};
use statglass_session::RemoteError;

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
            RemoteError::Refused(_) => Self::Internal { message },
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
