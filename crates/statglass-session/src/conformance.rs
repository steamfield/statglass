//! The behavior every [`Dialer`] must show against a live host running the StatGlass
//! agent. The OpenSSH and russh dialers run it in their Docker tests.
use crate::{Dialer, Endpoint};
use statglass_schema::HostId;
use std::sync::Arc;

/// A live host to run the suite against.
pub struct ConformanceHost {
    /// Reaches the host with its agent running.
    pub endpoint: Endpoint,
    /// Reaches the same host but starts the agent against a socket nothing serves.
    pub stopped: Endpoint,
    /// The agent's host id.
    pub host_id: HostId,
}

/// A session opens, identifies the host, streams live data and answers a ping.
pub async fn live_session(_dialer: &dyn Dialer, _host: &ConformanceHost) {
    unimplemented!("phase 2 lane a")
}

/// A host whose agent is stopped reads as `AgentNotRunning`.
pub async fn agent_not_running(_dialer: &dyn Dialer, _host: &ConformanceHost) {
    unimplemented!("phase 2 lane a")
}

/// A `RemoteSource` connects and advances its mirror's sync cursor.
pub async fn source_syncs_mirror(_dialer: Arc<dyn Dialer>, _host: &ConformanceHost) {
    unimplemented!("phase 2 lane a")
}
