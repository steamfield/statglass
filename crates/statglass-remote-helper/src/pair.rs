//! The helper as the one-time pairing key's forced command (`pair --nonce <n>`, RFC
//! `plan/rfc-ios-app.md` 2.4): relays the phone's `PairStart` to the app's control socket
//! through `statglass_remote::run_forced`.
//!
//! Scaffold: phase 5 lane b implements it.

/// Runs the pairing exchange for `nonce`; returns the process exit code. Scaffold stub:
/// exit 2 until phase 5 lane b.
pub fn run(nonce: &str) -> i32 {
    eprintln!("statglass-remote-helper: pairing {nonce} is not available in this build");
    2
}
