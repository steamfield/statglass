//! The live producer: subscriptions, frame coalescing, process interest and window
//! visibility, behind a `LiveSink` each app implements for its own channel.
//!
//! Scaffold: phase 3 lane a moves `src-tauri/src/live.rs` and `live/` here (`LiveFeed`,
//! `LiveSink`, `RecentFeed`, `LiveMsg`, `LiveStatus`, `SubscriptionInfo`, `LiveRequest`
//! and the rest of `LiveRegistry`), replacing this file.
use crate::process::RefusalSource;
use std::sync::Arc;

/// Every live subscription and the window visibility they depend on.
#[derive(Default)]
pub struct LiveRegistry {
    #[expect(
        dead_code,
        reason = "read by the live producer phase 3 lane a moves in"
    )]
    refusals: Option<Arc<dyn RefusalSource>>,
}

impl LiveRegistry {
    /// A registry with no refusal source: every process row has `refusal: None`.
    pub fn new() -> Self {
        Self::default()
    }

    /// A registry whose process rows carry the refusals `refusals` gives each batch.
    pub fn with_refusals(refusals: Arc<dyn RefusalSource>) -> Self {
        Self {
            refusals: Some(refusals),
        }
    }

    /// Installs the callback told `(window label, visible)` when a window's visibility
    /// changes. Scaffold stub: dropped until phase 3 lane a.
    pub fn set_visibility_emitter(&self, emit: impl Fn(&str, bool) + Send + Sync + 'static) {
        let _ = emit;
    }
}
