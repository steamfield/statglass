use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions, Permissions},
    io::{self, BufRead, BufReader, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use serde::Serialize;
use serde_json::Value;
use statglass_schema::HostId;
use uuid::Uuid;

use super::{DeviceTag, EcdsaP256Public, IntentError, IntentOp, IntentRecord, PendingIntent};

#[derive(Default)]
pub(super) struct Journal {
    last_seq: u64,
    pub(super) complete_bytes: u64,
    has_unknown_ops: bool,
    entries: BTreeMap<(HostId, DeviceTag), Entry>,
}

struct Entry {
    intent: IntentRecord,
    key: Option<EcdsaP256Public>,
    outcome: Option<IntentRecord>,
    attempts: u32,
}

impl Entry {
    fn is_pending(&self) -> bool {
        !matches!(
            self.outcome.as_ref().map(|record| &record.op),
            Some(IntentOp::Applied { .. })
        )
    }
}

impl Journal {
    pub(super) fn read(
        file: &File,
        path: &Path,
        warned_unknown_seq: &AtomicU64,
    ) -> Result<Self, IntentError> {
        let mut journal = Self::default();
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        loop {
            line.clear();
            let bytes = reader.read_until(b'\n', &mut line)?;
            if bytes == 0 {
                break;
            }
            if line.last() != Some(&b'\n') {
                tracing::warn!(path = %path.display(), "ignoring a truncated device intent");
                break;
            }
            journal
                .read_record(&line, path, warned_unknown_seq)
                .map_err(|error| {
                    IntentError::Invalid(format!(
                        "{} at byte {}: {error}",
                        path.display(),
                        journal.complete_bytes
                    ))
                })?;
            journal.complete_bytes += bytes as u64;
        }
        Ok(journal)
    }

    fn read_record(
        &mut self,
        line: &[u8],
        path: &Path,
        warned_unknown_seq: &AtomicU64,
    ) -> Result<(), IntentError> {
        let value: Value = serde_json::from_slice(line).map_err(invalid_json)?;
        let op = value
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| IntentError::Invalid("missing op".into()))?;
        if !matches!(op, "install" | "revoke" | "applied" | "failed") {
            let seq = value
                .get("seq")
                .and_then(Value::as_u64)
                .ok_or_else(|| IntentError::Invalid("missing sequence".into()))?;
            self.advance(seq)?;
            self.has_unknown_ops = true;
            if warned_unknown_seq.fetch_max(seq, Ordering::Relaxed) < seq {
                tracing::warn!(path = %path.display(), seq, op, "ignoring an unknown device intent");
            }
            return Ok(());
        }
        // Older rows and ordinary appends represent one attempt. Compaction folds
        // the count into the last failure so retries still show the total.
        let attempts = match value.get("attempts") {
            None => 1,
            Some(value) => serde_json::from_value(value.clone()).map_err(invalid_json)?,
        };
        self.apply(
            serde_json::from_value(value).map_err(invalid_json)?,
            attempts,
        )
    }

    pub(super) fn next_seq(&self) -> Result<u64, IntentError> {
        self.last_seq
            .checked_add(1)
            .ok_or_else(|| IntentError::Invalid("sequence overflow".into()))
    }

    fn advance(&mut self, seq: u64) -> Result<(), IntentError> {
        if seq <= self.last_seq {
            return Err(IntentError::Invalid("sequences must increase".into()));
        }
        self.last_seq = seq;
        Ok(())
    }

    pub(super) fn apply(&mut self, record: IntentRecord, attempts: u32) -> Result<(), IntentError> {
        self.advance(record.seq)?;
        let device = DeviceTag::parse(&record.device)
            .ok_or_else(|| IntentError::Invalid("invalid device tag".into()))?;
        let pair = (record.host, device);
        match &record.op {
            IntentOp::Install { .. } | IntentOp::Revoke => {
                let key = match &record.op {
                    IntentOp::Install { key, .. } => {
                        let key = decode_key(key)?;
                        if DeviceTag::from_key(&key) != device {
                            return Err(IntentError::Invalid(
                                "device tag does not match the public key".into(),
                            ));
                        }
                        Some(key)
                    }
                    _ => None,
                };
                self.entries.insert(
                    pair,
                    Entry {
                        intent: record,
                        key,
                        outcome: None,
                        attempts: 0,
                    },
                );
            }
            IntentOp::Applied { seq } | IntentOp::Failed { seq, .. } => {
                if let Some(entry) = self.entries.get_mut(&pair)
                    && entry.intent.seq == *seq
                    && entry.is_pending()
                {
                    if matches!(record.op, IntentOp::Failed { .. }) {
                        entry.attempts = entry.attempts.saturating_add(attempts);
                    }
                    entry.outcome = Some(record);
                }
            }
        }
        Ok(())
    }

    pub(super) fn current(&self, seq: u64) -> Option<(HostId, DeviceTag)> {
        self.entries.iter().find_map(|(&pair, entry)| {
            (entry.intent.seq == seq && entry.is_pending()).then_some(pair)
        })
    }

    pub(super) fn pending(&self) -> Vec<PendingIntent> {
        let mut pending = Vec::new();
        for (&(host, device), entry) in self.entries.iter().filter(|(_, entry)| entry.is_pending())
        {
            let install = match &entry.intent.op {
                IntentOp::Install { name, .. } => entry.key.clone().map(|key| (key, name.clone())),
                _ => None,
            };
            let last_error = match entry.outcome.as_ref().map(|record| &record.op) {
                Some(IntentOp::Failed { reason, .. }) => Some(reason.clone()),
                _ => None,
            };
            pending.push(PendingIntent {
                seq: entry.intent.seq,
                host,
                device,
                install,
                attempts: entry.attempts,
                last_error,
            });
        }
        pending.sort_unstable_by_key(|intent| intent.seq);
        pending
    }

    pub(super) fn installed_hosts(&self, device: &DeviceTag) -> Vec<HostId> {
        self.entries
            .iter()
            .filter_map(|(&(host, tag), entry)| {
                (tag == *device && matches!(entry.intent.op, IntentOp::Install { .. }))
                    .then_some(host)
            })
            .collect()
    }

    pub(super) fn can_compact(&self) -> bool {
        // Leave a newer writer's records in place.
        !self.has_unknown_ops
    }

    fn snapshot(self) -> Vec<(IntentRecord, u32)> {
        let mut rows = Vec::new();
        for entry in self.entries.into_values() {
            rows.push((entry.intent, 1));
            if let Some(outcome) = entry.outcome {
                let attempts = if matches!(outcome.op, IntentOp::Failed { .. }) {
                    entry.attempts
                } else {
                    1
                };
                rows.push((outcome, attempts));
            }
        }
        rows.sort_unstable_by_key(|(row, _)| row.seq);
        rows
    }
}

fn decode_key(key: &str) -> Result<EcdsaP256Public, IntentError> {
    EcdsaP256Public::from_base64(key).map_err(|error| IntentError::Invalid(error.to_string()))
}

fn invalid_json(error: serde_json::Error) -> IntentError {
    IntentError::Invalid(error.to_string())
}

pub(super) fn open_private(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular intent log or lock file",
        ));
    }
    if metadata.permissions().mode() & 0o7777 != 0o600 {
        file.set_permissions(Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

pub(super) fn append(
    mut file: impl Write,
    record: &IntentRecord,
    attempts: u32,
) -> Result<(), IntentError> {
    fn one(attempts: &u32) -> bool {
        *attempts == 1
    }

    #[derive(Serialize)]
    struct Line<'a> {
        #[serde(flatten)]
        record: &'a IntentRecord,
        #[serde(skip_serializing_if = "one")]
        attempts: u32,
    }

    let mut bytes = serde_json::to_vec(&Line { record, attempts }).map_err(invalid_json)?;
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    Ok(())
}

pub(super) fn compact(path: &Path, directory: &Path, journal: Journal) -> Result<(), IntentError> {
    let staged = directory.join(format!(".statglass-intents-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&staged)?;
    let result = (|| {
        file.set_permissions(Permissions::from_mode(0o600))?;
        for (row, attempts) in journal.snapshot() {
            append(&mut file, &row, attempts)?;
        }
        file.sync_all()?;
        fs::rename(&staged, path)?;
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err()
        && let Err(error) = fs::remove_file(&staged)
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(path = %staged.display(), %error, "removing staged device intents");
    }
    result
}
