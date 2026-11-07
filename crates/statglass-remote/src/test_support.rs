//! Helpers shared by the crate's unit tests.

use std::time::Duration;

use statglass_schema::{HostId, HostInfo, HostRecord, OsKind};

/// A local host with every optional fact absent; tests set what they assert on.
pub(crate) fn bare_host(id: u128, name: &str, os: OsKind) -> HostRecord {
    HostRecord {
        id: HostId(uuid::Uuid::from_u128(id)),
        is_local: true,
        display_name: name.into(),
        info: HostInfo {
            os,
            os_version: String::new(),
            model: None,
            chip: None,
            chip_known: false,
            cpu_topology: Vec::new(),
            mem_total_bytes: 0,
            boot_time_ms: 0,
            gpu_dvfs_mhz: Vec::new(),
            kernel: None,
            boot_mounts: Vec::new(),
        },
    }
}

/// A local Mac named "Mac" on macOS 27.0 with a chip the sensor map knows.
pub(crate) fn mac_host(id: u128) -> HostRecord {
    let mut record = bare_host(id, "Mac", OsKind::MacOs);
    record.info.os_version = "27.0".into();
    record.info.chip_known = true;
    record
}

/// A ceiling for [`eventually`] on a loaded machine; a condition that holds returns at once.
pub(crate) const WAIT: Duration = Duration::from_secs(10);

/// Polls `f` every 5 ms until it returns true, panicking with `what` after `timeout`.
pub(crate) async fn eventually(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + timeout;
    while !f() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
