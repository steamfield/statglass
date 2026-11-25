//! The error every command returns, on the desktop and the phone
//! (`.claude/rules/rust/error-handling.md`). Serialized with a `kind` tag so the frontend
//! can switch on it. Every `From<crate error>` it needs lives here, because the orphan rule
//! keeps a foreign error's conversion next to this type; errors of crates this one must
//! never depend on (`statglass-remote`) map through functions in their caller.

use serde::Serialize;
use statglass_schema::{HostId, JsSafeInt};
use statglass_store::StoreError;

mod remote;
pub use remote::PairingFailure;
#[cfg(all(unix, not(target_os = "ios")))]
mod services;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommandError {
    #[error("update: {message}")]
    Update { message: String },
    /// SSH login to the other Mac failed (key, agent or account).
    #[error("{message}")]
    RemoteAuth { message: String },
    /// The phone needs its local SSH key before it can connect.
    #[error("the phone's SSH key is unavailable")]
    PhoneKeyUnavailable,
    /// The other Mac's host key isn't trusted yet, or needs checking in Terminal.
    #[error("{message}")]
    HostKeyUnknown { message: String },
    /// The other Mac can't run this StatGlass (architecture, macOS or protocol version).
    #[error("{message}")]
    RemoteIncompatible { message: String },
    /// The Mac that answered is not the one this host was added as.
    #[error("{message}")]
    RemoteIdentity { message: String },
    /// The other Mac could not be reached, or the connection broke.
    #[error("{message}")]
    RemoteUnreachable { message: String },
    /// A connected host is too busy or slow to answer a query now; retry shortly.
    #[error("{message}")]
    RemoteBusy { message: String },
    /// A connected, current host does not offer what was asked (its edition or setup).
    #[error("{message}")]
    RemoteUnsupported { message: String },
    /// The host refused the query.
    #[error("{message}")]
    RemoteRefused { message: String },
    /// The Linux host has too little free space for the agent's history budget plus the
    /// low-disk reserve.
    #[error("{message}")]
    RemoteLowDisk { message: String },
    /// The Linux host already has an agent this setup must not replace (installed for
    /// another login), or has none where one was expected.
    #[error("{message}")]
    RemoteAgentConflict { message: String },
    /// The agent is installed but its service is not answering.
    #[error("{message}")]
    RemoteAgentNotRunning { message: String },
    /// Updating the agent failed. `restored` says whether the previous version and its
    /// history were put back and are running again.
    #[error("{message}")]
    RemoteAgentUpdateFailed { message: String, restored: bool },
    /// A bounded, sanitized Docker monitoring error.
    #[error("Docker: {message}")]
    Docker { message: String },
    /// The requested container, retained run or storage resource no longer exists.
    #[error("Docker: {message}")]
    DockerNotFound { message: String },
    /// The preview or inventory changed before the action could be performed.
    #[error("Docker: {message}")]
    DockerSnapshotExpired { message: String },
    /// A bounded request exceeded the service's supported resource limit.
    #[error("Docker: {message}")]
    DockerResourceLimit { message: String },
    /// No host with this id is registered.
    #[error("unknown host {host}")]
    UnknownHost { host: HostId },
    /// The host is not this Mac, and the data asked for is kept only on the host it
    /// describes: per-app network bytes are not synced (D-089).
    #[error("host {host} does not share this data")]
    RemoteHost { host: HostId },
    /// There is no history store: it could not be opened at launch, the local host could
    /// not be registered in it, or a reset failed. StatGlass runs live-only. `reason` says
    /// why when it is known; `reset_history` can recover from everything but `locked`.
    #[error("history is unavailable")]
    HistoryUnavailable {
        #[specta(optional)]
        reason: Option<HistoryUnavailableReason>,
    },
    /// The database is busy (another writer holds it, or a lock wait timed out). Worth one
    /// retry.
    #[error("history store is busy: {message}")]
    StoreBusy { message: String },
    /// The database file is damaged. `reset_history` moves it aside and starts a new one.
    #[error("history store is corrupt: {message}")]
    StoreCorrupt { message: String },
    /// A newer StatGlass wrote the database; this build cannot read it.
    #[error("history store schema {found} is newer than this build supports ({supported})")]
    StoreTooNew {
        #[specta(type = JsSafeInt)]
        found: i64,
        #[specta(type = JsSafeInt)]
        supported: i64,
    },
    /// Any other history query or write failure.
    #[error("history store: {message}")]
    Store { message: String },
    /// A disk space scan could not start, or its report is gone.
    #[error("{message}")]
    DiskSpace { message: String },
    /// A bug or a crashed worker inside StatGlass (a command's task panicked). Not retryable.
    #[error("internal error: {message}")]
    Internal { message: String },
    /// The settings patch produced settings that fail validation. Nothing changed.
    #[error("invalid settings: {message}")]
    InvalidSettings { message: String },
    /// The settings file could not be written. Nothing changed.
    #[error("cannot save settings: {message}")]
    SettingsNotSaved { message: String },
    /// Registering or unregistering the login item failed. Nothing changed.
    #[error("launch at login: {message}")]
    LaunchAtLogin { message: String },
    /// An argument is out of range (a negative span, an empty selector list).
    #[error("invalid argument: {message}")]
    InvalidArgument { message: String },
    /// A window could not be created or shown.
    #[error("window: {message}")]
    Window { message: String },
    /// The export file could not be created or written (no permission, disk full). No
    /// partial file is left behind.
    #[error("export: {message}")]
    Export { message: String },
    /// The public address lookup failed: offline, the service unreachable or timing
    /// out, or an answer that is not an address (a captive portal).
    #[error("public address: {message}")]
    PublicIp { message: String },
    /// The other Mac is reachable but StatGlass is not running there.
    #[error("{message}")]
    RemoteNotRunning { message: String },
    /// The other Mac's StatGlass has remote monitoring turned off.
    #[error("{message}")]
    RemoteMonitoringOff { message: String },
    /// Pairing a phone, or editing the paired devices, failed (RFC 2.4, 2.5).
    #[error("pairing: {message}")]
    Pairing {
        reason: PairingFailure,
        message: String,
    },
}

impl CommandError {
    /// `history_unavailable` with no known reason.
    pub const fn history_unavailable() -> Self {
        CommandError::HistoryUnavailable { reason: None }
    }
}

pub use statglass_engine::HistoryUnavailableReason;

impl From<statglass_schema::RangeError> for CommandError {
    fn from(e: statglass_schema::RangeError) -> Self {
        CommandError::InvalidArgument {
            message: e.to_string(),
        }
    }
}

impl From<statglass_schema::durable_usage::UsageRequestError> for CommandError {
    fn from(e: statglass_schema::durable_usage::UsageRequestError) -> Self {
        CommandError::InvalidArgument {
            message: e.to_string(),
        }
    }
}

impl From<StoreError> for CommandError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Usage(message) => CommandError::InvalidArgument { message },
            StoreError::UnknownHost(host) => CommandError::UnknownHost { host },
            StoreError::WriterGone => CommandError::history_unavailable(),
            StoreError::TooNew { found, supported } => {
                CommandError::StoreTooNew { found, supported }
            }
            e => {
                let message = store_message(&e);
                if e.is_busy() {
                    CommandError::StoreBusy { message }
                } else if e.is_corrupt() {
                    CommandError::StoreCorrupt { message }
                } else {
                    CommandError::Store { message }
                }
            }
        }
    }
}

fn store_message(error: &StoreError) -> String {
    // SQLite's extended code is useful; its standard explanation often repeats its message.
    if let StoreError::Sqlite(statglass_store::rusqlite::Error::SqliteFailure(code, Some(detail))) =
        error
        && !detail.is_empty()
    {
        return format!("sqlite: {detail} (code {})", code.extended_code);
    }

    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let detail = cause.to_string();
        // StoreError's Display already includes its immediate cause.
        if message != detail
            && !message
                .strip_suffix(&detail)
                .is_some_and(|prefix| prefix.ends_with(": "))
        {
            message.push_str(": ");
            message.push_str(&detail);
        }
        source = cause.source();
    }
    message
}

impl From<statglass_engine::HistoryStoreError> for CommandError {
    fn from(error: statglass_engine::HistoryStoreError) -> Self {
        match error {
            statglass_engine::HistoryStoreError::Unavailable { reason } => {
                Self::HistoryUnavailable { reason }
            }
            statglass_engine::HistoryStoreError::Store(error) => error.into(),
        }
    }
}

#[cfg(test)]
mod tests;
