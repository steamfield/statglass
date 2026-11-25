//! The host side of pairing (RFC `plan/rfc-ios-app.md` 2.4): offer a one-time pairing
//! key, bind it to the first `PairStart`, and complete only when the host's approver
//! says so. Also the forced `pair` command every host runs for the phone.
//!
//! Scaffold: phase 5 lane b implements the approval state machine and `run_forced`.
use crate::device_keys::{DeviceKeys, DeviceKeysError};
use statglass_proto::pairing::{BundleHost, PairError, PairReply, PairStart, PairingPayload};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

/// The `command=` prefixes for the lines pairing installs; the nonce or device tag is
/// appended.
pub struct PairCommands {
    /// The forced `pair` command, before `--nonce <n>`.
    pub pair: String,
    /// The forced restricted command, before `--device <tag>`.
    pub restricted: String,
}

/// Why the host could not offer or decide a pairing.
#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error(transparent)]
    Keys(#[from] DeviceKeysError),
    #[error("{0}")]
    Pair(#[from] PairError),
}

/// Every open pairing offer on this host and the keys it edits.
pub struct PairingHost {
    keys: Arc<dyn DeviceKeys>,
    commands: PairCommands,
}

/// The reply every scaffold stub gives.
const UNAVAILABLE: PairReply = PairReply::Error {
    error: PairError::Unavailable,
};

impl PairingHost {
    /// A host that edits `keys` and forces `commands`.
    pub fn new(keys: Arc<dyn DeviceKeys>, commands: PairCommands) -> Self {
        Self { keys, commands }
    }

    /// Installs a pairing line for `host` valid for `ttl` and returns the QR payload.
    /// Scaffold stub: [`PairError::Unavailable`] until phase 5 lane b.
    pub fn offer(
        &self,
        host: BundleHost,
        ttl: Duration,
        now_ms: i64,
    ) -> Result<PairingPayload, PairingError> {
        let _ = (&self.keys, &self.commands, host, ttl, now_ms);
        Err(PairError::Unavailable.into())
    }

    /// Binds the offer to the phone's first `PairStart`. Scaffold stub: unavailable.
    pub fn start(&self, req: &PairStart, now_ms: i64) -> PairReply {
        let _ = (req, now_ms);
        UNAVAILABLE
    }

    /// The pairing client's view: `Waiting` until a final reply. Scaffold stub: unavailable.
    pub fn status(&self, nonce: &str, now_ms: i64) -> PairReply {
        let _ = (nonce, now_ms);
        UNAVAILABLE
    }

    /// The approver's view: `Pending` with the device and code until a final reply.
    /// Scaffold stub: unavailable.
    pub fn pending(&self, nonce: &str, now_ms: i64) -> PairReply {
        let _ = (nonce, now_ms);
        UNAVAILABLE
    }

    /// Writes the device line, then removes the pairing line. Scaffold stub: unavailable.
    pub fn approve(&self, nonce: &str, now_ms: i64) -> Result<PairReply, PairingError> {
        let _ = (nonce, now_ms);
        Err(PairError::Unavailable.into())
    }

    /// Refuses the pairing and removes its line. Scaffold stub: unavailable.
    pub fn deny(&self, nonce: &str) -> Result<(), PairingError> {
        let _ = nonce;
        Err(PairError::Unavailable.into())
    }

    /// Withdraws the offer and removes its line. Scaffold stub: unavailable.
    pub fn cancel(&self, nonce: &str) -> Result<(), PairingError> {
        let _ = nonce;
        Err(PairError::Unavailable.into())
    }

    /// Expires every offer past its TTL at `now_ms`. Scaffold stub: a no-op.
    pub fn expire(&self, now_ms: i64) {
        let _ = now_ms;
    }
}

/// The forced `pair` command on any host: relay PairStart, poll PairStatus every second
/// (each request under the 10 s control cap) until a final reply. Returns the exit code.
/// Scaffold stub: exits 2 until phase 5 lane b.
pub async fn run_forced<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    stdin: R,
    stdout: W,
    control: &Path,
) -> i32 {
    let _ = (stdin, stdout, control);
    2
}
