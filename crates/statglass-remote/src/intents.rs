//! The controller's device-key intents for remote hosts.

use std::{
    fs::{DirBuilder, File},
    io::Seek,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::atomic::AtomicU64,
};

use serde::{Deserialize, Serialize};
use statglass_schema::HostId;

use crate::{DeviceTag, EcdsaP256Public};

mod journal;
use journal::{Journal, append, compact, open_private};

const COMPACT_ABOVE_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum IntentOp {
    Install {
        key: String,
        name: String,
    },
    Revoke,
    Applied {
        #[serde(rename = "applied_seq")]
        seq: u64,
    },
    Failed {
        #[serde(rename = "failed_seq")]
        seq: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntentRecord {
    pub seq: u64,
    pub host: HostId,
    pub device: String,
    #[serde(flatten)]
    pub op: IntentOp,
    pub at_ms: i64,
}

pub struct IntentLog {
    path: PathBuf,
    warned_unknown_seq: AtomicU64,
}

impl IntentLog {
    pub fn open(path: PathBuf) -> Result<Self, IntentError> {
        let log = Self {
            path,
            warned_unknown_seq: AtomicU64::new(0),
        };
        create_directory(log.directory())?;
        log.with_file(|_| {
            // The first successful append must survive the directory entry being new.
            File::open(log.directory())?.sync_all()?;
            Ok(())
        })?;
        Ok(log)
    }

    pub fn record(
        &self,
        host: HostId,
        device: DeviceTag,
        op: IntentOp,
        now_ms: i64,
    ) -> Result<u64, IntentError> {
        if !matches!(op, IntentOp::Install { .. } | IntentOp::Revoke) {
            return Err(IntentError::Invalid("expected an install or revoke".into()));
        }
        self.with_file(|file| {
            let journal = self.read(file)?;
            self.write(file, journal, host, device, op, now_ms)
        })
    }

    pub fn pending(&self) -> Result<Vec<PendingIntent>, IntentError> {
        self.with_file(|file| Ok(self.read(file)?.pending()))
    }

    /// Every host whose latest intent for this device is an install, including
    /// ones that have already applied it.
    pub fn installed_hosts(&self, device: &DeviceTag) -> Result<Vec<HostId>, IntentError> {
        self.with_file(|file| Ok(self.read(file)?.installed_hosts(device)))
    }

    pub fn mark_applied(&self, seq: u64, now_ms: i64) -> Result<(), IntentError> {
        self.mark(seq, IntentOp::Applied { seq }, now_ms)
    }

    pub fn mark_failed(&self, seq: u64, reason: &str, now_ms: i64) -> Result<(), IntentError> {
        self.mark(
            seq,
            IntentOp::Failed {
                seq,
                reason: reason.into(),
            },
            now_ms,
        )
    }

    fn mark(&self, seq: u64, op: IntentOp, now_ms: i64) -> Result<(), IntentError> {
        self.with_file(|file| {
            let journal = self.read(file)?;
            if let Some((host, device)) = journal.current(seq) {
                self.write(file, journal, host, device, op, now_ms)?;
            }
            Ok(())
        })
    }

    fn read(&self, file: &File) -> Result<Journal, IntentError> {
        let journal = Journal::read(file, &self.path, &self.warned_unknown_seq)?;
        if file.metadata()?.len() > journal.complete_bytes {
            // Repair an interrupted append once, even if the applier is only polling.
            file.set_len(journal.complete_bytes)?;
            file.sync_all()?;
        }
        Ok(journal)
    }

    fn write(
        &self,
        file: &mut File,
        mut journal: Journal,
        host: HostId,
        device: DeviceTag,
        op: IntentOp,
        now_ms: i64,
    ) -> Result<u64, IntentError> {
        let record = IntentRecord {
            seq: journal.next_seq()?,
            host,
            device: device.to_string(),
            op,
            at_ms: now_ms,
        };
        journal.apply(record.clone(), 1)?;
        file.seek(std::io::SeekFrom::End(0))?;
        append(&mut *file, &record, 1)?;
        file.sync_all()?;
        if journal.can_compact()
            && let Err(error) = self.compact_if_large(file, journal)
        {
            tracing::warn!(path = %self.path.display(), %error, "compacting device intents");
        }
        Ok(record.seq)
    }

    fn compact_if_large(&self, file: &File, journal: Journal) -> Result<(), IntentError> {
        if file.metadata()?.len() > COMPACT_ABOVE_BYTES {
            compact(&self.path, self.directory(), journal)?;
        }
        Ok(())
    }

    fn with_file<T>(
        &self,
        action: impl FnOnce(&mut File) -> Result<T, IntentError>,
    ) -> Result<T, IntentError> {
        let mut lock_path = self.path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock = open_private(Path::new(&lock_path))?;
        lock.lock()?;
        action(&mut open_private(&self.path)?)
    }

    fn directory(&self) -> &Path {
        parent(&self.path)
    }
}

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|part| !part.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn create_directory(directory: &Path) -> std::io::Result<()> {
    let mut missing = Vec::new();
    let mut path = directory;
    while !path.try_exists()? {
        missing.push(path);
        path = parent(path);
    }
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    for created in missing.into_iter().rev() {
        File::open(parent(created))?.sync_all()?;
    }
    Ok(())
}

pub struct PendingIntent {
    pub seq: u64,
    pub host: HostId,
    pub device: DeviceTag,
    pub install: Option<(EcdsaP256Public, String)>,
    pub attempts: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum IntentError {
    #[error("intent log: {0}")]
    Io(#[from] std::io::Error),
    #[error("intent log: {0}")]
    Invalid(String),
}
