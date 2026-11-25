//! Live process rows and why StatGlass will not signal a process. The refusal rule is
//! injected: the desktop supplies `process_signal`'s, and a phone supplies none.
//!
//! Scaffold: phase 3 lane a moves `LiveProcess` here from `src-tauri/src/live_process.rs`
//! and `live_quit_set`'s body from `src-tauri/src/app_quit.rs`.
use serde::Serialize;
use statglass_engine::ProcessSample;
use std::collections::HashSet;

/// Why StatGlass will not signal a process. The UI words it (`process-signal.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SignalRefusal {
    /// The macOS kernel (pid 0), or a pid kill(2) would treat as a process group.
    KernelTask,
    Launchd,
    WindowServer,
    LoginWindow,
    /// StatGlass itself or one of its helpers.
    #[serde(rename = "statglass")]
    StatGlass,
}

/// The refusal rule for one live batch, taking `(pid, start_time_us, name)`.
pub type RefusalRule<'a> = Box<dyn Fn(i32, i64, &str) -> Option<SignalRefusal> + 'a>;

/// Per-batch refusal rule. The desktop supplies process_signal's; a phone supplies none.
pub trait RefusalSource: Send + Sync {
    /// The rule for one live batch. Anything it needs once per batch (this process's
    /// pid, StatGlass's own processes) is read here.
    fn batch(&self) -> RefusalRule<'_>;
}

/// The `(pid, start_time_us)` of every row in `rows` that Quit on its app acts on.
/// Scaffold stub: empty until phase 3 lane a moves the body from `app_quit.rs`.
pub fn live_quit_set(rows: &[ProcessSample]) -> HashSet<(i32, i64)> {
    let _ = rows;
    HashSet::new()
}
