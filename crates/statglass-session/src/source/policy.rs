//! How a caller tunes a source for its platform: the runtime it runs on, how much
//! history it syncs, how it reads the local network, and backgrounding (quiesce and
//! resume). The desktop passes [`SourceOptions::default`], which is today's behavior.
//!
//! Scaffold: the options are accepted and ignored, and the lifecycle calls are no-ops,
//! until phase 3 lane c implements them.
use super::{RemoteSource, StatusCallback};
use crate::network::LocalNetwork;
use crate::{BoxFuture, Dialer, Endpoint, MirrorSink};
use statglass_schema::{HostId, HostRecord};
use std::sync::Arc;
use std::time::Duration;

/// How long a session on a changed network waits for a Pong to its immediate Ping
/// before it is dropped as a dead route.
pub const NETWORK_CHANGE_PROBE: Duration = Duration::from_secs(5);

/// How much history a source syncs into its mirror. Live frames flow under every policy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SyncPolicy {
    /// Every tier the sink keeps.
    #[default]
    Full,
    /// Only the coarsest tier the sink keeps (a phone on cellular).
    SummaryOnly,
    /// No sync requests at all.
    Off,
}

/// A source's platform choices. `Default` is the desktop's.
#[derive(Clone, Default)]
pub struct SourceOptions {
    /// The runtime the source's task runs on; `None` runs it on its own thread, as today.
    pub runtime: Option<tokio::runtime::Handle>,
    /// How much history to sync.
    pub sync: SyncPolicy,
    /// Reads the local network; `None` uses [`crate::network::probe`].
    pub probe: Option<Arc<dyn Fn() -> LocalNetwork + Send + Sync>>,
}

impl RemoteSource {
    /// [`RemoteSource::new`] with platform options. Scaffold stub: `options` is ignored
    /// until phase 3 lane c.
    pub fn with_options(
        record: HostRecord,
        local: HostId,
        dialer: Arc<dyn Dialer>,
        endpoint: Endpoint,
        on_status: StatusCallback,
        mirror: Option<Arc<dyn MirrorSink>>,
        options: SourceOptions,
    ) -> Arc<Self> {
        let _ = options;
        Self::new(record, local, dialer, endpoint, on_status, mirror)
    }

    /// Changes how much history the source syncs, without reconnecting. Scaffold stub:
    /// a no-op until phase 3 lane c.
    pub fn set_sync_policy(&self, policy: SyncPolicy) {
        let _ = policy;
    }

    /// Lets an ingest already running commit, then closes the session and parks until
    /// [`resume`](Self::resume). Scaffold stub: resolves at once until phase 3 lane c.
    pub fn quiesce(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }

    /// Dials again at once with the backoff reset. Scaffold stub: a no-op until phase 3
    /// lane c.
    pub fn resume(&self) {}
}
