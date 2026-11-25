//! What `serve` prints when it cannot reach the app's metrics socket, so the phone and
//! the desktop tell "StatGlass isn't running" from "remote monitoring is off"
//! (`statglass_session::APP_NOT_RUNNING` and `MONITORING_OFF`).
//!
//! Scaffold: phase 5 lane a implements the control `Status` check.

/// Bridges the metrics socket, or prints the marker for why it is unreachable and
/// returns exit 3. Scaffold stub: exit 3 with no marker until phase 5 lane a.
#[expect(dead_code, reason = "phase 5 lane a calls it from both serve paths")]
pub fn serve_or_marker() -> i32 {
    3
}
