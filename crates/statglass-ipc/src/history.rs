//! History and events queries as commands see them: the request a client sends, the page
//! it gets back, and the store reads behind them. A caller says how `Auto` resolves for
//! its store: the desktop keeps every tier (`TierChoice::Auto`), a phone mirror less
//! (`TierChoice::Covered`).

use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use statglass_engine::HistoryStore;
use statglass_schema::{Event, Gap, HostId, JsSafeInt, SeriesKey, SeriesSelector, Tier};
use statglass_store::{BucketRow, TierChoice};

mod ipc;

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
    /// to stay under `max_points` (a 7d range at 1,008 points: 600,000, "10 MIN AVG"). A
    /// point at `t` covers `[t, t + bucket_ms)`.
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
    /// How long a point stays current, ms (D-092): the hold of the slowest period the
    /// series is sampled at, or the page's `bucket_ms` if that is larger. Consecutive
    /// points no more than this apart are one line; further apart, there is a hole
    /// between them. `gaps` stays the list of explicit holes.
    ///
    /// The period is the slowest under the current settings (the backed-off base tick,
    /// the collector's idle cadence, Performance mode's slowdown), or, when the range
    /// starts before the last time a period got faster in this app run (a shorter
    /// sampling interval), the slowest under any settings this run, since the range's
    /// earlier points were sampled under those. Settings persist across launches, so
    /// earlier runs count as sampled under the settings this one started with.
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

/// The stored tier plus `recent` bucket rows, which replace stored rows of the same
/// bucket and layout. With the store unavailable, the recent rows alone answer.
/// `hold` supplies each series' `hold_ms`. Blocking.
pub fn query_history(
    history: &HistoryStore,
    request: &HistoryRequest,
    auto: TierChoice,
    recent: impl Fn() -> Vec<BucketRow>,
    hold: impl Fn(&SeriesKey, i64) -> i64,
) -> Result<HistoryPage, CommandError> {
    let query = request.to_query_with(auto)?;
    Ok(ipc::history_page(
        history.history_through_now(&query, recent)?,
        hold,
    ))
}

/// Events of `host` with `from_ms <= ts < to_ms`, oldest first. Blocking.
pub fn query_events(
    history: &HistoryStore,
    host: HostId,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<Event>, CommandError> {
    Ok(history.read(|r| r.events(host, from_ms, to_ms))?)
}

#[cfg(test)]
mod tests;
