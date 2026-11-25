//! The agent as a paired phone's forced command (`restricted --device <tag>`, RFC
//! `plan/rfc-ios-app.md` 2.3): the helper's token table over the agent's socket, with
//! `--system` or `--socket` baked into the `authorized_keys` line.
//!
//! Scaffold: phase 5 lane a implements it.
use statglass_remote::SocketPaths;

/// Runs the forced command for `device` against `paths`; returns the exit code.
/// Scaffold stub: refuses (exit 2) until phase 5 lane a.
pub fn run(device: &str, paths: &SocketPaths) -> anyhow::Result<i32> {
    let _ = paths;
    eprintln!(
        "statglass-agent: restricted mode for device {device} is not available in this build"
    );
    Ok(2)
}
