//! When each restricted device last connected, kept beside the host's other state so
//! "Paired devices" can show it. A write failure is logged and never fails the session.
use crate::device_keys::DeviceTag;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;

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
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.path)?;
        Self::require_regular(&file)?;
        // A leading newline lets the next record start fresh after an interrupted write.
        let mut bytes = vec![b'\n'];
        serde_json::to_writer(&mut bytes, &seen)?;
        bytes.push(b'\n');
        // One append write reserves the record's offset without waiting on a
        // userspace lock. A short write leaves a partial line that read skips.
        if file.write(&bytes)? == bytes.len() {
            return Ok(());
        }
        Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "incomplete device seen record",
        ))
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
        for line in BufReader::new(file).split(b'\n') {
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
