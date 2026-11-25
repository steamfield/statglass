use std::time::Duration;

use serde_json::Value;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::HostDemand;
use statglass_session::RemoteSource;

use crate::lifecycle::Lifecycle;

use super::Sessions;

/// How long a host stays connected after no screen demands it. Long enough that swiping
/// across the pager and back, or a quick look at Settings, keeps the SSH session (a fresh
/// dial and handshake costs 1-3 s on LAN, more on Tailscale); short enough that nothing
/// keeps pulling once the user has moved on.
pub(crate) const PARK_GRACE: Duration = Duration::from_secs(15);

pub(crate) fn set_demand(
    _sessions: &Sessions,
    _demand: Vec<HostDemand>,
) -> Result<Value, CommandError> {
    let _ = PARK_GRACE;
    Ok(Value::Null)
}

pub(crate) fn admit(_source: &RemoteSource, _lifecycle: &Lifecycle) {}
