//! What the app-lifecycle code may do to the running sessions, without knowing how they
//! are kept. `Sessions` implements it; lifecycle tests use a fake holding real sources.

use std::sync::Arc;

use statglass_session::network::LocalNetwork;
use statglass_session::{RemoteSource, SyncPolicy};

/// The running sessions, as backgrounding, foregrounding and path changes see them.
#[expect(
    dead_code,
    reason = "phase 4 lane d's lifecycle calls these; it removes this expectation"
)]
pub(crate) trait SessionControl: Send + Sync {
    /// Every running source, the open host's first (the host with a live stream).
    fn sources(&self) -> Vec<Arc<RemoteSource>>;
    /// Applies `policy` to every running source and to sources started later.
    fn set_sync_policy(&self, policy: SyncPolicy);
    /// Tells every running source the local network changed.
    fn network_changed(&self, net: LocalNetwork);
}
