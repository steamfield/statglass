//! The shared handshake and the race across an endpoint's targets, on top of any
//! [`Dialer`].
use crate::{Dialer, Endpoint, RemoteError, Result, SshSession};
use statglass_schema::HostId;
use std::time::Duration;

/// How long one target gets for its dial and the StatGlass Hello, counted from the dial
/// start, so it also bounds the dialer's own connect.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest one failing connection attempt runs. Every target dials at once under
/// the same limit, and the preference grace only applies after a target has succeeded,
/// so this bounds the race too.
pub const DIAL_TIMEOUT_MS: i64 = HANDSHAKE_TIMEOUT.as_millis() as i64;
/// How long a less-preferred success waits for a more-preferred target still pending.
pub const ROUTE_GRACE: Duration = Duration::from_millis(500);
/// How long after a network change a source waits before racing better routes.
pub const PROMOTION_DEBOUNCE: Duration = Duration::from_secs(2);

/// Dials every target of `endpoint` at once, runs the handshake on each stream and
/// returns the preferred session. `local` is this device's host id (a host answering
/// with it is this device); `expected` is the paired host's id, when known.
pub async fn connect(
    _dialer: &dyn Dialer,
    _endpoint: &Endpoint,
    _local: HostId,
    _expected: Option<HostId>,
) -> Result<SshSession> {
    Err(RemoteError::Transport("not implemented".into()))
}
