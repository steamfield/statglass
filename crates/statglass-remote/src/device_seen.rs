//! When each restricted device last connected, kept beside the host's other state so
//! "Paired devices" can show it. A write failure is logged and never fails the session.
//!
//! Scaffold: phase 5 lane a implements the log.
use crate::device_keys::DeviceTag;
use std::collections::BTreeMap;
use std::path::PathBuf;

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
    /// Scaffold stub: records nothing until phase 5 lane a.
    pub fn record(&self, device: DeviceTag, now_ms: i64) {
        let _ = (&self.path, device, now_ms);
    }

    /// Each device's last-seen time, ms epoch. Scaffold stub: empty until phase 5 lane a.
    pub fn read(&self) -> BTreeMap<DeviceTag, i64> {
        BTreeMap::new()
    }
}
