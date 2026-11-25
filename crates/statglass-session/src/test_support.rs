//! Helpers shared by the crate's unit tests.

use crate::{
    BoxFuture, DialFailure, DialedStream, Dialer, Endpoint, RemoteError, Result, Route, Target,
};
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

/// The Hello sent by the in-memory host in source tests.
pub(crate) fn fixture_hello() -> statglass_proto::Hello {
    let mut record = bare_host(1, "Remote Mac", OsKind::MacOs);
    record.info.os_version = "15".into();
    record.info.mem_total_bytes = 1;
    statglass_proto::Hello {
        proto_version: statglass_proto::PROTO_VERSION,
        min_compatible: statglass_proto::MIN_COMPATIBLE,
        app_version: "test".into(),
        host: record.identity(),
        db_instance_uuid: uuid::Uuid::from_u128(2),
        capabilities: statglass_schema::Capabilities::default(),
        features: statglass_proto::local_features(),
    }
}

pub(crate) fn endpoint(routes: &[(Route, &str)]) -> Endpoint {
    Endpoint {
        targets: routes
            .iter()
            .map(|&(route, host)| Target {
                route,
                host: host.into(),
            })
            .collect(),
        port: None,
        user: None,
        host_keys: Vec::new(),
        command: crate::RemoteCommand::default(),
    }
}

/// Tests that pass a negotiated session directly should never dial.
pub(crate) struct UnusedDialer;

impl Dialer for UnusedDialer {
    fn dial<'a>(&'a self, _: &'a Endpoint, _: &'a Target) -> BoxFuture<'a, Result<DialedStream>> {
        panic!("this test supplied its own session")
    }

    fn classify(&self, _: &DialFailure<'_>) -> RemoteError {
        panic!("this test supplied its own session")
    }
}
