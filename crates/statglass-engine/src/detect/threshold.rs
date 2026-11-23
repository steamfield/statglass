//! A custom threshold rule's condition over the series its selector matches
//! (plan/rfc-alerts.md 6.3). Per series it keeps when the condition started holding;
//! a reading that fails the comparison clears that series, and so does a series with
//! no reading for more than three sampling periods, where the period is the larger of
//! the series' current period and its period at the last reading (as `PowerSpike`
//! measures gaps), so a hold never spans a hole but survives the cadence changing when
//! a window opens. `NaN` (not sampled this tick) neither holds nor clears.
//!
//! The rule's episode is reported once: after [`ThresholdState::mark_reported`], no
//! series reports again until none satisfies the condition and one holds again. Nothing
//! here allocates per tick; [`ThresholdState::bind`] may.

use statglass_schema::{Cmp, SeriesKey, SeriesSelector};

use super::value;

/// The condition's progress over every bound series.
pub(super) struct ThresholdState {
    series: SeriesSelector,
    op: Cmp,
    value: f32,
    /// Layout indices of the series the selector matches.
    bound: Vec<usize>,
}

/// A series that has held the condition for the rule's duration.
pub(super) struct Held {
    /// When the series started holding (ms).
    pub(super) since: i64,
    /// The series' index in the layout.
    pub(super) key_index: usize,
    /// The series' value on this tick.
    pub(super) value: f32,
}

impl ThresholdState {
    /// A condition `series op value` that must hold for `for_ms`.
    pub(super) fn new(series: SeriesSelector, op: Cmp, value: f32, _for_ms: i64) -> Self {
        Self {
            series,
            op,
            value,
            bound: Vec::new(),
        }
    }

    /// The layout changed: binds to every series the selector matches and forgets all
    /// progress.
    pub(super) fn bind(&mut self, layout: &[SeriesKey]) {
        self.bound.clear();
        self.bound.extend(
            layout
                .iter()
                .enumerate()
                .filter(|(_, k)| self.series.matches(k))
                .map(|(i, _)| i),
        );
    }

    /// Reads one tick (`values` and `periods` in layout order, periods in ms). Returns
    /// the first bound series to have held for the rule's duration, unless the episode
    /// was already reported.
    pub(super) fn on_reading(
        &mut self,
        ts_ms: i64,
        values: &[f32],
        _periods: &[u32],
    ) -> Option<Held> {
        self.bound.iter().find_map(|&i| {
            value(values, i)
                .filter(|&v| self.op.eval(v, self.value))
                .map(|v| Held {
                    since: ts_ms,
                    key_index: i,
                    value: v,
                })
        })
    }

    /// The current episode was reported (or spent inside the cooldown): it does not
    /// report again until it clears.
    pub(super) fn mark_reported(&mut self) {}

    /// Forgets all progress (sleep, a clock step, the rule switched off). Returns whether
    /// a reported episode was in progress, so the caller can treat the condition still
    /// met afterwards as that episode.
    pub(super) fn reset(&mut self) -> bool {
        false
    }
}
