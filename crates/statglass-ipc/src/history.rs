//! History and events queries as commands see them: the request a client sends, the page
//! it gets back, and the store reads behind them. A caller says how `Auto` resolves for
//! its store: the desktop keeps every tier (`TierChoice::Auto`), a phone mirror less
//! (`TierChoice::Covered`).
//!
//! Scaffold: phase 3 lane a moves the history types from `src-tauri/src/ipc.rs`,
//! `src-tauri/src/history/ipc.rs` and the store-only part of
//! `src-tauri/src/history/queries.rs` here, replacing these stubs.
use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use statglass_engine::HistoryStore;
use statglass_schema::{Event, Gap, HostId, JsSafeInt, SeriesKey, SeriesSelector, Tier};
use statglass_store::{HistoryQuery, TierChoice};

/// Which tier `query_history` reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TierRequest {
    /// 10 s buckets while they cover the start of the range (24 h); otherwise 1 min while
    /// minutes cover it (7 days), else 15 min.
    Auto,
    S10,
    M1,
    M15,
}

#[derive(Clone, Debug, PartialEq, Deserialize, specta::Type)]
pub struct HistoryRequest {
    pub host: HostId,
    pub selectors: Vec<SeriesSelector>,
    /// Inclusive start, ms epoch.
    #[specta(type = JsSafeInt)]
    pub from_ms: i64,
    /// Exclusive end, ms epoch.
    #[specta(type = JsSafeInt)]
    pub to_ms: i64,
    pub tier: TierRequest,
    /// Upper bound on points per series; buckets are merged to stay under it.
    pub max_points: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct HistoryPage {
    /// The tier the points came from.
    pub tier: Tier,
    /// The width each point averages over, ms: the tier's bucket times the buckets merged
    /// to stay under `max_points`. A point at `t` covers `[t, t + bucket_ms)`.
    #[specta(type = JsSafeInt)]
    pub bucket_ms: i64,
    pub series: Vec<HistorySeries>,
    /// Gaps overlapping the range. Split lines at these; never interpolate.
    pub gaps: Vec<Gap>,
}

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct HistorySeries {
    pub key: SeriesKey,
    pub points: Vec<HistoryPoint>,
    /// How long a point stays current, ms (D-092).
    #[specta(type = JsSafeInt)]
    pub hold_ms: i64,
}

/// One merged slot. Slots with no measured value are absent, never zero.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, specta::Type)]
pub struct HistoryPoint {
    #[specta(type = JsSafeInt)]
    pub t: i64,
    pub min: f32,
    pub max: f32,
    pub avg: f32,
}

impl HistoryRequest {
    /// The store query, with `Auto` read as [`TierChoice::Auto`] (the desktop).
    pub fn to_query(&self) -> Result<HistoryQuery, CommandError> {
        self.to_query_with(TierChoice::Auto)
    }

    /// The store query, with `Auto` read as `auto` (a phone mirror passes its policy's
    /// `Covered` choice). Scaffold stub: not implemented until phase 3 lane a.
    pub fn to_query_with(&self, auto: TierChoice) -> Result<HistoryQuery, CommandError> {
        let _ = auto;
        Err(not_implemented())
    }
}

/// Per-series points from one tier of `host`'s history through now. Lane a fixes the
/// exact parameters from the desktop caller it moves (`commands.rs` `query_history`).
/// Scaffold stub: not implemented until phase 3 lane a.
pub fn query_history(
    history: &HistoryStore,
    request: &HistoryRequest,
    auto: TierChoice,
) -> Result<HistoryPage, CommandError> {
    let _ = (history, request, auto);
    Err(not_implemented())
}

/// Events of `host` with `from_ms <= ts < to_ms`, oldest first. Lane a fixes the exact
/// parameters from the desktop caller it moves (`commands.rs` `query_events`). Scaffold
/// stub: not implemented until phase 3 lane a.
pub fn query_events(
    history: &HistoryStore,
    host: HostId,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<Event>, CommandError> {
    let _ = (history, host, from_ms, to_ms);
    Err(not_implemented())
}

fn not_implemented() -> CommandError {
    CommandError::Internal {
        message: "not implemented".into(),
    }
}
