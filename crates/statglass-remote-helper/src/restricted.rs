//! The helper as a restricted key's forced command (`restricted --device <tag>`, RFC
//! `plan/rfc-ios-app.md` 2.3): compares `SSH_ORIGINAL_COMMAND` exactly against `serve`,
//! `version` and `status`, and refuses anything else with exit 2.
//!
//! Scaffold: phase 5 lane a implements the token table and the preface.

/// Runs the forced command for `device`; returns the process exit code. Scaffold stub:
/// refuses everything (exit 2) until phase 5 lane a.
pub fn run(device: &str) -> i32 {
    eprintln!(
        "statglass-remote-helper: restricted mode for device {device} is not available in this build"
    );
    2
}
