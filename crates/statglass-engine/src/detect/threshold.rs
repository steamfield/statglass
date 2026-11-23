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

/// How many sampling periods a series may go without a reading before its hold is
/// cleared.
const MAX_GAP_PERIODS: i64 = 3;

/// The condition's progress over every bound series.
pub(super) struct ThresholdState {
    series: SeriesSelector,
    op: Cmp,
    value: f32,
    for_ms: i64,
    /// One entry per series the selector matches, in layout order.
    bound: Vec<SeriesProgress>,
    /// The current episode was reported; cleared once no series holds.
    reported: bool,
}

/// One bound series' progress.
struct SeriesProgress {
    /// The series' index in the layout.
    key_index: usize,
    /// When the series started holding the condition (ms), while it holds.
    since: Option<i64>,
    /// When the series last had a reading (ms).
    last_ts: i64,
    /// The series' sampling period at its last reading (ms).
    last_period: u32,
}

/// What one tick said about one series.
enum Observation {
    /// No reading and no gap: nothing changed.
    Nothing,
    /// The series does not hold the condition (a failing reading, or a gap).
    Clear,
    /// The series holds the condition with this reading.
    Holds(f32),
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

impl SeriesProgress {
    fn new(key_index: usize) -> Self {
        Self {
            key_index,
            since: None,
            last_ts: 0,
            last_period: 0,
        }
    }

    /// Whether more than [`MAX_GAP_PERIODS`] of the expected spacing passed since the
    /// last reading. Across a cadence change the longer period is the one to expect: a
    /// window opening must not read the 10 s since the last idle reading as a hole.
    fn silent_too_long(&self, ts_ms: i64, period: u32) -> bool {
        let expected = i64::from(period.max(self.last_period));
        expected > 0 && ts_ms - self.last_ts > expected * MAX_GAP_PERIODS
    }

    /// Reads this tick's value for the series against `op value`.
    fn observe(
        &mut self,
        ts_ms: i64,
        values: &[f32],
        periods: &[u32],
        op: Cmp,
        threshold: f32,
    ) -> Observation {
        let period = periods.get(self.key_index).copied().unwrap_or(0);
        let gap = self.since.is_some() && self.silent_too_long(ts_ms, period);
        if gap {
            self.since = None;
        }
        let Some(reading) = value(values, self.key_index) else {
            return if gap {
                Observation::Clear
            } else {
                Observation::Nothing
            };
        };
        self.last_ts = ts_ms;
        self.last_period = period;
        if !op.eval(reading, threshold) {
            self.since = None;
            return Observation::Clear;
        }
        self.since.get_or_insert(ts_ms);
        Observation::Holds(reading)
    }
}

impl ThresholdState {
    /// A condition `series op value` that must hold for `for_ms`.
    pub(super) fn new(series: SeriesSelector, op: Cmp, value: f32, for_ms: i64) -> Self {
        Self {
            series,
            op,
            value,
            for_ms,
            bound: Vec::new(),
            reported: false,
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
                .map(|(i, _)| SeriesProgress::new(i)),
        );
        self.reported = false;
    }

    /// Reads one tick (`values` and `periods` in layout order, periods in ms). Returns
    /// the first bound series to have held for the rule's duration, unless the episode
    /// was already reported.
    pub(super) fn on_reading(
        &mut self,
        ts_ms: i64,
        values: &[f32],
        periods: &[u32],
    ) -> Option<Held> {
        let mut observed = false;
        let mut holding = false;
        let mut first: Option<Held> = None;
        for progress in &mut self.bound {
            let reading = match progress.observe(ts_ms, values, periods, self.op, self.value) {
                Observation::Nothing => {
                    holding |= progress.since.is_some();
                    continue;
                }
                Observation::Clear => {
                    observed = true;
                    continue;
                }
                Observation::Holds(reading) => reading,
            };
            observed = true;
            holding = true;
            let Some(since) = progress.since else {
                continue;
            };
            let complete = ts_ms - since >= self.for_ms;
            if complete && first.as_ref().is_none_or(|f| since < f.since) {
                first = Some(Held {
                    since,
                    key_index: progress.key_index,
                    value: reading,
                });
            }
        }
        // A tick with no reading and no gap says nothing about whether the episode
        // ended, so only a tick that saw something can close it.
        if observed && !holding {
            self.reported = false;
        }
        first.filter(|_| !self.reported)
    }

    /// The current episode was reported (or spent inside the cooldown): it does not
    /// report again until it clears.
    pub(super) fn mark_reported(&mut self) {
        self.reported = true;
    }

    /// Forgets all progress (sleep, a clock step, the rule switched off). Returns whether
    /// a reported episode was in progress, so the caller can treat the condition still
    /// met afterwards as that episode.
    pub(super) fn reset(&mut self) -> bool {
        for progress in &mut self.bound {
            progress.since = None;
            progress.last_period = 0;
        }
        std::mem::replace(&mut self.reported, false)
    }
}
