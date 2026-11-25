//! Tauri adapter for shared live subscriptions.
pub use statglass_ipc::live::*;

/// Sends live messages through a webview's Tauri channel.
pub struct TauriSink(pub(crate) tauri::ipc::Channel<LiveMsg>);

impl LiveSink for TauriSink {
    fn send(&self, msg: LiveMsg) -> bool {
        self.0.send(msg).is_ok()
    }
    fn id(&self) -> u32 {
        self.0.id()
    }
}

#[cfg(test)]
#[path = "live_host_tests.rs"]
mod host_tests;
