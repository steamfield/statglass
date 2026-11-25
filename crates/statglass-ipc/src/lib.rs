#![cfg_attr(test, allow(clippy::too_many_lines))]
//! The platform-neutral command layer shared by the desktop and the phone: the error every
//! command returns, the live producer, history and events queries, host vitals,
//! connection status and live process rows. Each app adapts it to its own edge (Tauri
//! commands and channels on the desktop, the UniFFI facade on the phone).
//!
//! It never depends on `statglass-remote`, `tauri` or `tauri-specta`; every type here
//! derives `specta::Type` so the desktop's one exporter writes it to the shared bindings.
pub mod error; // CommandError and every From<crate error> it needs (scaffold-owned)
pub mod history; // TierRequest, HistoryRequest/HistoryPage/HistorySeries/HistoryPoint, query_history, query_events
pub mod live; // LiveFeed, LiveSink, LiveRegistry, RecentFeed, LiveMsg/LiveStatus/SubscriptionInfo, LiveRequest
pub mod process; // LiveProcess, SignalRefusal (data only), RefusalSource, live_quit_set
pub mod status; // RemoteConnection, RemoteState/RemoteRoute/RemoteSync/RemoteFailureKind/RemoteRouteFailure
pub mod vitals; // HostVitals, MemoryPressure, host_vitals
