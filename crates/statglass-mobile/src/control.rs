//! What the app-lifecycle code may do to the running sessions, without knowing how they
//! are kept. `Sessions` implements it; lifecycle tests use a fake holding real sources.

use std::sync::Arc;

use statglass_session::RemoteSource;
use statglass_session::network::LocalNetwork;

/// The running sessions, as backgrounding, foregrounding and path changes see them.
pub(crate) trait SessionControl: Send + Sync {
    /// Every running source, the open host's first (the host with a live stream).
    fn sources(&self) -> Vec<Arc<RemoteSource>>;
    /// Tells every running source the local network changed.
    fn network_changed(&self, net: LocalNetwork);
}
