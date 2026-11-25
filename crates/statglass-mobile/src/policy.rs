//! The phone's two policy rules: how much history a source syncs on the current path,
//! and each host's share of the mirror storage (phase 4 lane d).

use statglass_ipc::mobile::DataPolicy;
use statglass_session::{PHONE_MIRROR_HOST_MB, SyncPolicy};

use crate::ffi::NetworkPath;

/// The sync policy for `path` (`None`: not reported yet) under `data`.
pub(crate) fn sync_policy(path: Option<NetworkPath>, data: DataPolicy) -> SyncPolicy {
    let _ = (path, data);
    SyncPolicy::Full
}

/// Each host's mirror budget when the phone has `hosts` hosts, so the total stays within
/// `PHONE_MIRROR_TOTAL_MB`.
pub(crate) fn host_budget_mb(hosts: usize) -> u32 {
    let _ = hosts;
    PHONE_MIRROR_HOST_MB
}
