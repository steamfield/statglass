//! Event detectors and alert rules (v1.2, architecture.md "Event detectors"). They read
//! the same per-tick values the rollups do, plus process batches when the processes
//! collector produced one, and emit [`Event`]s that the engine stores and publishes.
//!
//! Cost: a detector's tick is a few comparisons over values already in hand. Nothing
//! allocates on a tick that fires nothing (the per-tick allocation gate covers this), and
//! attribution reads the batches the processes collector produces anyway, never asking
//! for more (D-083).

mod alerts;
mod detectors;
mod threshold;
mod window;

use statglass_collect::ProcessSample;
use statglass_schema::{
    AlertRule, AlertSettings, DetectorThresholds, Event, EventDetail, PowerComponent, SeriesKey,
};

pub use alerts::AlertEval;
pub use detectors::{FansRamped, PowerSpike, SustainedProcess, ThermalChange};
pub use window::{Measure, ProcessWindow};

/// What a detector sees on one tick.
pub struct TickInput<'a> {
    pub ts_ms: i64,
    /// Each series' sampling period on this tick, in layout order (the larger of its
    /// catalog period, its collector's current period and the base tick), for detectors
    /// that must tell a missed reading from the normal spacing. A collector's period
    /// changes with what is visible: IOReport reads every 10 s tray-only, every tick with
    /// a window open.
    pub periods: &'a [u32],
    /// Values measured on this tick in layout order, `NaN` where a series was not sampled
    /// (`LiveFrame::values`). Never held values: a detector sees each reading once.
    pub values: &'a [f32],
    /// This tick's process rows, when the processes collector ran.
    pub batch: Option<&'a [ProcessSample]>,
    /// The last minute of process batches, for attribution.
    pub recent: &'a ProcessWindow,
}

pub trait Detector: Send {
    /// The layout changed: find the series this detector reads. Resets its state.
    fn bind(&mut self, series: &[SeriesKey]);
    /// Reads one tick; pushes any events to `out`.
    fn on_tick(&mut self, input: &TickInput<'_>, out: &mut Vec<Event>);
    /// Forgets what it was tracking (after sleep, a pause or a clock step), so a
    /// comparison never spans a hole.
    fn reset(&mut self);
}

/// The index of the unlabelled series `metric`.
fn find(series: &[SeriesKey], metric: &str) -> Option<usize> {
    series
        .iter()
        .position(|k| k.metric.as_str() == metric && k.labels.is_empty())
}

/// The value at `i` when it was measured this tick.
fn value(values: &[f32], i: usize) -> Option<f32> {
    values.get(i).copied().filter(|v| !v.is_nan())
}

/// How far back an alert rule's last firing still holds it off: the longest cooldown
/// among every rule in `alerts`, built-in and custom, on or off. The app shell reads
/// stored alerts this far back at launch ([`Detectors::seed_alert_history`]).
pub fn alert_history_ms(alerts: &AlertSettings) -> i64 {
    alerts
        .engine_rules()
        .iter()
        .map(|r| i64::from(r.cooldown_secs) * 1000)
        .max()
        .unwrap_or(0)
}

/// Whether two versions of a rule watch for the same condition over the same duration.
/// The name, cooldown and switch are not part of it: editing them keeps the progress.
fn same_definition(a: &AlertRule, b: &AlertRule) -> bool {
    a.when == b.when && a.for_secs == b.for_secs
}

/// Every detector plus the alert rules, fed by the engine once per persisted tick.
/// Every built-in rule has an evaluator, on or off, so a rule switched off and on again
/// keeps its cooldown; each custom rule has one while it is in the settings.
pub struct Detectors {
    detectors: Vec<Box<dyn Detector>>,
    alerts: Vec<AlertEval>,
    window: ProcessWindow,
    series: Vec<SeriesKey>,
}

impl Detectors {
    pub fn new(th: DetectorThresholds, alerts: &AlertSettings) -> Self {
        let mut d = Self {
            detectors: vec![
                Box::new(FansRamped::new(th)),
                Box::new(ThermalChange::new(th)),
                Box::new(SustainedProcess::new(th)),
                Box::new(PowerSpike::new(th, PowerComponent::Package)),
                Box::new(PowerSpike::new(th, PowerComponent::Ane)),
            ],
            alerts: Vec::new(),
            window: ProcessWindow::new(th.attribution_window_ms),
            series: Vec::new(),
        };
        d.set_alerts(alerts);
        d
    }

    /// Binds every detector to a new layout.
    pub fn bind(&mut self, series: &[SeriesKey]) {
        self.series.clear();
        self.series.extend_from_slice(series);
        for d in &mut self.detectors {
            d.bind(series);
        }
        for a in &mut self.alerts {
            a.bind(series);
        }
        self.window.clear();
    }

    /// The processes collector's idle period (10 s, or 30 s in Performance mode), which
    /// caps how much time one batch stands for in attribution.
    pub fn set_process_idle_ms(&mut self, idle_ms: u32) {
        self.window.set_idle_ms(idle_ms);
    }

    /// Applies the alert settings, matching evaluators by rule id. A rule whose condition
    /// and duration stay the same keeps its progress, taking any new name or cooldown;
    /// one switched off forgets its progress (it sees nothing while off) but keeps its
    /// cooldown, so switching it back on cannot re-fire it at once. A custom rule whose
    /// condition or duration changed gets a new evaluator that keeps the old one's
    /// cooldown; a custom rule no longer in the settings is dropped; a new one is bound
    /// to the current layout at once.
    pub fn set_alerts(&mut self, settings: &AlertSettings) {
        let mut previous = std::mem::take(&mut self.alerts);
        for rule in settings.engine_rules() {
            let kept = previous
                .iter()
                .position(|a| a.rule().id == rule.id)
                .map(|i| previous.swap_remove(i));
            let eval = self.evaluator_for(rule, kept);
            self.alerts.push(eval);
        }
    }

    /// The evaluator for `rule`: `kept` (its evaluator so far) with the edited rule
    /// swapped in when the definition is the same, otherwise a new one bound to the
    /// current layout that keeps `kept`'s cooldown.
    fn evaluator_for(&self, rule: AlertRule, kept: Option<AlertEval>) -> AlertEval {
        match kept {
            Some(mut eval) if same_definition(eval.rule(), &rule) => {
                eval.set_rule(rule);
                eval
            }
            kept => {
                let mut eval = AlertEval::new(rule);
                eval.bind(&self.series);
                if let Some(old) = &kept {
                    eval.keep_cooldown_from(old);
                }
                eval
            }
        }
    }

    /// Restores each rule's cooldown from stored alert events (the newest per rule), so
    /// a restart does not re-fire a rule that fired minutes ago. Other events and rules
    /// this build does not know are ignored.
    pub fn seed_alert_history(&mut self, events: &[Event]) {
        for e in events {
            let EventDetail::Alert { rule_id, .. } = &e.detail else {
                continue;
            };
            if let Some(eval) = self.alerts.iter_mut().find(|a| a.rule().id == *rule_id) {
                eval.fired_at(e.ts_ms, &e.processes);
            }
        }
    }

    /// Runs one tick. Events go to `out`; two of one kind on one tick get distinct
    /// timestamps, a millisecond apart, since the store keys events on host, ts and kind.
    pub fn on_tick(
        &mut self,
        ts_ms: i64,
        values: &[f32],
        periods: &[u32],
        batch: Option<&[ProcessSample]>,
        out: &mut Vec<Event>,
    ) {
        if let Some(rows) = batch {
            self.window.push(ts_ms, rows);
        }
        let first = out.len();
        let input = TickInput {
            ts_ms,
            periods,
            values,
            batch,
            recent: &self.window,
        };
        for d in &mut self.detectors {
            d.on_tick(&input, out);
        }
        for a in self.alerts.iter_mut().filter(|a| a.rule().enabled) {
            a.on_tick(&input, out);
        }
        for i in first + 1..out.len() {
            let (done, rest) = out.split_at_mut(i);
            let Some(e) = rest.first_mut() else { continue };
            let kind = e.detail.kind();
            if let Some(last) = done
                .iter()
                .skip(first)
                .filter(|p| p.detail.kind() == kind)
                .map(|p| p.ts_ms)
                .max()
                && last >= e.ts_ms
            {
                e.ts_ms = last + 1;
            }
        }
    }

    /// Forgets every detector's progress and the process window. Alert cooldowns stay.
    pub fn reset(&mut self) {
        for d in &mut self.detectors {
            d.reset();
        }
        for a in &mut self.alerts {
            a.reset();
        }
        self.window.clear();
    }
}

#[cfg(test)]
mod tests;

/// Editing a rule's name or cooldown keeps its progress and its reported episode; the
/// resumed-episode rule after a reset. Through [`Detectors`], one `mem.pressure` series.
#[cfg(test)]
mod rule_edit_tests {
    use statglass_schema::{
        AlertRule, AlertSettings, Cmp, Condition, DetectorThresholds, EventDetail, Labels,
        MetricId, SeriesKey, SeriesSelector,
    };
    use uuid::Uuid;

    use super::Detectors;

    const T0: i64 = 1_791_158_400_000;

    /// "`name`: memory pressure above 80% for `for_secs`", always the same id.
    fn memory(name: &str, for_secs: u32, cooldown_secs: u32) -> AlertRule {
        AlertRule {
            id: Uuid::from_u128(0xc001),
            name: name.to_owned(),
            when: Condition::Threshold {
                series: SeriesSelector {
                    metric: MetricId::from_static("mem.pressure"),
                    labels: Labels::new(),
                },
                op: Cmp::Gt,
                value: 80.0,
            },
            for_secs,
            cooldown_secs,
            enabled: true,
        }
    }

    fn settings(rule: AlertRule) -> AlertSettings {
        AlertSettings {
            rules: vec![rule],
            ..AlertSettings::default()
        }
    }

    /// One reading per second; records each alert as (second, rule name).
    struct Run {
        d: Detectors,
        sec: i64,
        fired: Vec<(i64, String)>,
    }

    impl Run {
        fn new(rule: AlertRule) -> Self {
            let mut d = Detectors::new(DetectorThresholds::DEFAULT, &settings(rule));
            d.bind(&[SeriesKey::new(
                MetricId::from_static("mem.pressure"),
                Labels::new(),
            )]);
            Self {
                d,
                sec: 0,
                fired: Vec::new(),
            }
        }

        /// Reads `value` every second until second `until` (exclusive).
        fn run_to(&mut self, until: i64, value: f32) {
            let mut out = Vec::new();
            while self.sec < until {
                let ts = T0 + self.sec * 1000;
                self.d.on_tick(ts, &[value], &[1000], None, &mut out);
                self.sec += 1;
            }
            for e in out {
                if let EventDetail::Alert { rule_name, .. } = e.detail {
                    self.fired.push(((e.ts_ms - T0) / 1000, rule_name));
                }
            }
        }

        fn edit(&mut self, rule: AlertRule) {
            self.d.set_alerts(&settings(rule));
        }
    }

    fn fired(at: &[(i64, &str)]) -> Vec<(i64, String)> {
        at.iter().map(|&(s, n)| (s, n.to_owned())).collect()
    }

    #[test]
    fn a_rename_inside_a_reported_episode_does_not_fire_it_again() {
        let mut r = Run::new(memory("Memory", 120, 1800));
        r.run_to(2000, 90.0);
        r.edit(memory("Memory high", 120, 1800));
        r.run_to(3000, 90.0);
        assert_eq!(r.fired, fired(&[(120, "Memory")]));
    }

    #[test]
    fn a_rename_during_a_hold_completes_it_on_schedule_under_the_new_name() {
        let mut r = Run::new(memory("Memory", 120, 1800));
        r.run_to(60, 90.0);
        r.edit(memory("Memory high", 120, 1800));
        r.run_to(300, 90.0);
        assert_eq!(r.fired, fired(&[(120, "Memory high")]));
    }

    /// Fired at 120 s, cleared, and holding again from 140 s. At 200 s the cooldown
    /// drops from 30 min to 1 min: the hold in progress completes at 260 s, past the
    /// new cooldown, and fires.
    #[test]
    fn a_shortened_cooldown_applies_without_restarting_progress() {
        let mut r = Run::new(memory("Memory", 120, 1800));
        r.run_to(130, 90.0);
        r.run_to(140, 50.0);
        r.run_to(200, 90.0);
        r.edit(memory("Memory", 120, 60));
        r.run_to(400, 90.0);
        assert_eq!(r.fired, fired(&[(120, "Memory"), (260, "Memory")]));
    }

    /// Fired at 120 s with a 60 s cooldown; a sleep at 150 s. The condition is still met
    /// afterwards, so it is the episode already reported, though the hold restarted at
    /// 150 s would complete at 270 s, past the cooldown.
    #[test]
    fn an_episode_still_met_after_a_reset_within_the_cooldown_is_not_reported_again() {
        let mut r = Run::new(memory("Memory", 120, 60));
        r.run_to(150, 90.0);
        r.d.reset();
        r.run_to(600, 90.0);
        assert_eq!(r.fired, fired(&[(120, "Memory")]));
        r.run_to(610, 50.0);
        r.run_to(800, 90.0);
        assert_eq!(r.fired, fired(&[(120, "Memory"), (730, "Memory")]));
    }
}

#[cfg(test)]
mod threshold_tests;
