//! The phone's side of pairing (RFC `plan/rfc-ios-app.md` 2.4): dial the host from the
//! QR with the one-time pairing key, send `PairStart`, wait for the host's decision, and
//! turn the approved bundle into the restricted [`Endpoint`] the phone keeps.
//!
//! Scaffold: phase 5 lane b implements both functions.
use crate::{Dialer, Endpoint, RemoteCommand, RemoteError};
use statglass_proto::pairing::{BundleHost, PairReply, PairingPayload};
use statglass_schema::HostId;

/// Pairs with the host in `payload`. `dialer` must authenticate with the payload's
/// pairing key (the caller builds it with that signer); the session runs
/// `RemoteCommand::Restricted { forced: Pair }`. Returns the restricted endpoint and the
/// final reply on approval, a typed error on denial or expiry. Scaffold stub: not
/// implemented until phase 5 lane b.
pub async fn pair(
    dialer: &dyn Dialer,
    payload: &PairingPayload,
    device_key: &[u8],
    device_name: &str,
    model: &str,
    local: HostId,
) -> Result<(Endpoint, PairReply), RemoteError> {
    let _ = (dialer, payload, device_key, device_name, model, local);
    Err(RemoteError::Transport("pairing not implemented".into()))
}

/// The endpoint the phone dials `host` at with `command`: its targets in order, port,
/// user and pinned host keys. Scaffold stub: not implemented until phase 5 lane b.
pub fn endpoint_from_host(
    host: &BundleHost,
    command: RemoteCommand,
) -> Result<Endpoint, RemoteError> {
    let _ = (host, command);
    Err(RemoteError::Transport("pairing not implemented".into()))
}
