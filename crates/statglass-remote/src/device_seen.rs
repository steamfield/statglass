//! When each restricted device last connected, kept beside the host's other state so
//! "Paired devices" can show it. A write failure is logged and never fails the session.
use crate::device_keys::DeviceTag;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, DirBuilder, File, Metadata, OpenOptions, TryLockError};
use std::io::{self, BufRead, BufReader, Read, Seek, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const COMPACT_ABOVE_BYTES: u64 = 64 * 1024;

#[derive(Deserialize, Serialize)]
struct Seen {
    device: DeviceTag,
    last_seen_ms: i64,
}

/// The last-seen log at one path.
pub struct DeviceSeenLog {
    path: PathBuf,
}

impl DeviceSeenLog {
    /// The log stored at `path`.
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Records that `device` connected at `now_ms`; logs on failure, never errors.
    pub fn record(&self, device: DeviceTag, now_ms: i64) {
        if let Err(error) = self.append(Seen {
            device,
            last_seen_ms: now_ms,
        }) {
            tracing::warn!(%device, path = %self.path.display(), error = &error as &dyn std::error::Error, "writing device seen log");
        }
    }

    fn append(&self, seen: Seen) -> io::Result<()> {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
        }
        loop {
            let mut file = OpenOptions::new()
                .create(true)
                .read(true)
                .append(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&self.path)?;
            Self::require_regular(&file)?;
            write_record(&mut file, &seen)?;
            let metadata = file.metadata()?;
            // Compaction can replace the named inode between opening and writing.
            // Retry on the new inode. Duplicate records are harmless.
            if !self.is_current(&metadata)? {
                continue;
            }
            if metadata.len() > COMPACT_ABOVE_BYTES {
                self.compact(file)?;
            }
            return Ok(());
        }
    }

    fn is_current(&self, inode: &Metadata) -> io::Result<bool> {
        let named = fs::symlink_metadata(&self.path)?;
        Ok((named.dev(), named.ino()) == (inode.dev(), inode.ino()))
    }

    fn compact(&self, mut file: File) -> io::Result<()> {
        if !try_lock(&file)? {
            return Ok(());
        }
        let metadata = file.metadata()?;
        if !self.is_current(&metadata)? {
            return Ok(());
        }
        let mut devices = BTreeMap::new();
        // The append may have moved this descriptor's position.
        file.rewind()?;
        read_records((&mut file).take(metadata.len()), &mut devices)?;
        let replacement = TemporaryLog::create(&self.path)?;
        replacement.write_snapshot(devices)?;
        // Prefer leaving the original untouched when we already know it changed.
        if !self.is_current(&metadata)? || file.metadata()?.len() != metadata.len() {
            return Ok(());
        }
        fs::rename(&replacement.path, &self.path)?;
        // Writers that finished before rename can have appended beyond the
        // snapshot. Writers that finish later retry once they see the new inode.
        let mut tail = BTreeMap::new();
        read_records(file, &mut tail)?;
        let mut append_to = &replacement.file;
        for (device, last_seen_ms) in tail {
            write_record(
                &mut append_to,
                &Seen {
                    device,
                    last_seen_ms,
                },
            )?;
        }
        Ok(())
    }

    /// Each device's latest last-seen time in milliseconds since the Unix epoch.
    pub fn read(&self) -> BTreeMap<DeviceTag, i64> {
        let mut devices = BTreeMap::new();
        if let Err(error) = self.read_into(&mut devices)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(path = %self.path.display(), error = &error as &dyn std::error::Error, "reading device seen log");
        }
        devices
    }

    fn read_into(&self, devices: &mut BTreeMap<DeviceTag, i64>) -> io::Result<()> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.path)?;
        Self::require_regular(&file)?;
        read_records(file, devices)
    }

    fn require_regular(file: &File) -> io::Result<()> {
        if file.metadata()?.is_file() {
            return Ok(());
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular device seen log",
        ))
    }
}

fn read_records(input: impl Read, devices: &mut BTreeMap<DeviceTag, i64>) -> io::Result<()> {
    for line in BufReader::new(input).split(b'\n') {
        let Ok(seen) = serde_json::from_slice::<Seen>(&line?) else {
            // A process interrupted during append may leave an incomplete record.
            continue;
        };
        devices
            .entry(seen.device)
            .and_modify(|last| *last = (*last).max(seen.last_seen_ms))
            .or_insert(seen.last_seen_ms);
    }
    Ok(())
}

fn write_record(output: &mut impl Write, seen: &Seen) -> io::Result<()> {
    // A leading newline lets the next record start fresh after an interrupted write.
    let mut bytes = vec![b'\n'];
    serde_json::to_writer(&mut bytes, seen)?;
    bytes.push(b'\n');
    // One append write reserves the record's offset without waiting on a lock.
    if output.write(&bytes)? == bytes.len() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::WriteZero,
        "incomplete device seen record",
    ))
}

fn try_lock(file: &File) -> io::Result<bool> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

struct TemporaryLog {
    path: PathBuf,
    file: File,
}

impl TemporaryLog {
    fn create(log: &Path) -> io::Result<Self> {
        let path = log.with_file_name(format!(".statglass-seen-{}.tmp", Uuid::new_v4()));
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .mode(0o600)
            .open(&path)?;
        let temp = Self { path, file };
        // Keep other compactors off the replacement until its tail is merged.
        if !try_lock(&temp.file)? {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        Ok(temp)
    }

    fn write_snapshot(&self, devices: BTreeMap<DeviceTag, i64>) -> io::Result<()> {
        let mut file = &self.file;
        for (device, last_seen_ms) in devices {
            write_record(
                &mut file,
                &Seen {
                    device,
                    last_seen_ms,
                },
            )?;
        }
        file.sync_all()
    }
}

impl Drop for TemporaryLog {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(path = %self.path.display(), error = &error as &dyn std::error::Error, "removing staged device seen log");
        }
    }
}
