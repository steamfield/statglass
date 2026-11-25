//! Pairing an iPhone with this host (RFC `plan/rfc-ios-app.md` 2.4): the interactive
//! `pair` that shows a QR and asks for approval on this terminal, and the forced
//! `pair --nonce` the one-time pairing key runs.
//!
//! Scaffold: phase 5 lane b implements both.
use std::time::Duration;

/// Offers a pairing for `ttl` and asks for approval on this terminal. Scaffold stub: not
/// implemented until phase 5 lane b.
pub fn interactive(ttl: Duration) -> anyhow::Result<()> {
    let _ = ttl;
    Err(anyhow::anyhow!("pairing is not implemented in this build"))
}

/// Relays the phone's `PairStart` for `nonce` to the interactive pairing's socket;
/// returns the exit code. Scaffold stub: exit 2 until phase 5 lane b.
pub fn forced(nonce: &str) -> anyhow::Result<i32> {
    eprintln!("statglass-agent: pairing {nonce} is not available in this build");
    Ok(2)
}
