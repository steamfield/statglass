use std::path::PathBuf;

use statglass_schema::{GapError, HostId, Tier};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("usage history: {0}")]
    Usage(String),
    #[error("Docker history: {0}")]
    Docker(String),
    /// Another `Store` holds the writer lock on this file: a second app instance, a dev
    /// build sharing the installed app's data, or (v4) an agent (architecture.md infra 8).
    #[error("history database {} is in use by another StatGlass process", path.display())]
    Locked { path: PathBuf },
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
    #[error("database schema version {found} is newer than this build supports ({supported})")]
    TooNew { found: i64, supported: i64 },
    #[error("corrupt database: {0}")]
    Corrupt(String),
    #[error("host {0} is not in the store")]
    UnknownHost(HostId),
    /// A non-local host was upserted with the local host's id: a cloned `host-id` on
    /// another Mac. Merging would demote this Mac's own host and mix the two (D-071).
    #[error("host {0} is this Mac's own id; a remote host cannot use it")]
    HostConflict(HostId),
    #[error("tier {0:?} is not persisted")]
    NotPersisted(Tier),
    #[error("bucket has {stats} stats for {series} series (expected 3 per series)")]
    StatsLength { series: usize, stats: usize },
    #[error("layout lists series {0} twice")]
    DuplicateSeries(String),
    #[error("page row refers to layout {0}, which the page does not define")]
    PageLayout(u32),
    #[error("invalid gap: {0}")]
    Gap(#[from] GapError),
    /// A bucket timestamp that is not on its tier's grid.
    #[error("bucket at {ts_ms} is not aligned to {width_ms} ms")]
    Misaligned { ts_ms: i64, width_ms: i64 },
    #[error("cbor: {0}")]
    Cbor(String),
    /// The writer thread has stopped, or is stopping: a long operation (pruning) that
    /// sees a shutdown queued behind it ends early with this.
    #[error("the store writer thread has stopped")]
    WriterGone,
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

impl StoreError {
    fn sqlite_code(&self) -> Option<rusqlite::ErrorCode> {
        match self {
            StoreError::Sqlite(e) => e.sqlite_error_code(),
            _ => None,
        }
    }

    /// Another process holds the file, or SQLite gave up waiting for a lock: worth
    /// retrying shortly.
    pub fn is_busy(&self) -> bool {
        matches!(self, StoreError::Locked { .. })
            || matches!(
                self.sqlite_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
            )
    }

    /// The file or a row in it is damaged: retrying will not help.
    pub fn is_corrupt(&self) -> bool {
        matches!(self, StoreError::Corrupt(_) | StoreError::Cbor(_))
            || matches!(
                self.sqlite_code(),
                Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite(code: i32) -> StoreError {
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(code),
            None,
        ))
    }

    #[test]
    fn classifies_busy_and_corrupt_failures() {
        let locked = StoreError::Locked {
            path: PathBuf::from("h.sqlite"),
        };
        for busy in [
            locked,
            sqlite(rusqlite::ffi::SQLITE_BUSY),
            sqlite(rusqlite::ffi::SQLITE_LOCKED),
        ] {
            assert!(busy.is_busy() && !busy.is_corrupt(), "{busy}");
        }
        for corrupt in [
            StoreError::Corrupt("bad blob".into()),
            StoreError::Cbor("bad cbor".into()),
            sqlite(rusqlite::ffi::SQLITE_CORRUPT),
            sqlite(rusqlite::ffi::SQLITE_NOTADB),
        ] {
            assert!(corrupt.is_corrupt() && !corrupt.is_busy(), "{corrupt}");
        }
        for neither in [sqlite(rusqlite::ffi::SQLITE_FULL), StoreError::WriterGone] {
            assert!(!neither.is_busy() && !neither.is_corrupt(), "{neither}");
        }
    }
}
