//! Custom threshold rules through [`Detectors`]: holding, clearing, gaps, cooldowns,
//! several series, resets, and rule edits at run time (plan/rfc-alerts.md 6.3).

use statglass_schema::{
    AlertCause, AlertRule, AlertSettings, Cmp, Condition, DetectorThresholds, Event, EventDetail,
    Labels, MetricId, SeriesKey, SeriesSelector,
};
use uuid::Uuid;

use super::{Detectors, alert_history_ms};

const T0: i64 = 1_791_158_400_000;
const S: i64 = 1000;
const MIN: i64 = 60 * S;

const MEM: usize = 0;
const FAN0: usize = 1;
const FAN1: usize = 2;
const BATTERY: usize = 3;

fn layout() -> Vec<SeriesKey> {
    [
        "mem.pressure",
        "fan.rpm{fan=0}",
        "fan.rpm{fan=1}",
        "battery.charge",
    ]
    .iter()
    .map(|k| SeriesKey::parse(k).unwrap())
    .collect()
}

fn custom(
    n: u128,
    metric: &'static str,
    labels: Labels,
    op: Cmp,
    value: f32,
    for_secs: u32,
    cooldown_secs: u32,
) -> AlertRule {
    AlertRule {
        id: Uuid::from_u128(0xc000 + n),
        name: format!("Rule {n}"),
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: MetricId::from_static(metric),
                labels,
            },
            op,
            value,
        },
        for_secs,
        cooldown_secs,
        enabled: true,
    }
}

/// Memory pressure above 80%.
fn memory(for_secs: u32, cooldown_secs: u32) -> AlertRule {
    custom(
        1,
        "mem.pressure",
        Labels::new(),
        Cmp::Gt,
        80.0,
        for_secs,
        cooldown_secs,
    )
}

fn settings(rules: Vec<AlertRule>) -> AlertSettings {
    AlertSettings {
        rules,
        ..AlertSettings::default()
    }
}

/// One tick per second from `T0`, each a value per series (`NaN` when not sampled),
/// with no process batches.
struct Run {
    d: Detectors,
    ts: i64,
    /// Each series' sampling period in ms, as the engine passes it.
    periods: [u32; 4],
    events: Vec<Event>,
}

impl Run {
    fn new(rules: Vec<AlertRule>) -> Self {
        let mut d = Detectors::new(DetectorThresholds::DEFAULT, &settings(rules));
        d.bind(&layout());
        Self {
            d,
            ts: T0,
            periods: [1000; 4],
            events: Vec::new(),
        }
    }

    fn tick(&mut self, set: &[(usize, f32)]) {
        let mut values = [f32::NAN; 4];
        for &(i, v) in set {
            values[i] = v;
        }
        self.d
            .on_tick(self.ts, &values, &self.periods, None, &mut self.events);
        self.ts += S;
    }

    /// Ticks until second `until` (exclusive), each with `f(second)`.
    fn run_to(&mut self, until: i64, f: impl Fn(i64) -> Vec<(usize, f32)>) {
        while self.ts < T0 + until * S {
            let sec = (self.ts - T0) / S;
            self.tick(&f(sec));
        }
    }

    fn alerts(&self) -> Vec<&Event> {
        self.events
            .iter()
            .filter(|e| e.detail.kind() == "alert")
            .collect()
    }

    /// The second of every alert.
    fn fired(&self) -> Vec<i64> {
        self.alerts().iter().map(|e| (e.ts_ms - T0) / S).collect()
    }
}

fn mem(v: f32) -> impl Fn(i64) -> Vec<(usize, f32)> {
    move |_| vec![(MEM, v)]
}

// ---- evaluation --------------------------------------------------------------------

#[test]
fn fires_once_when_the_condition_has_held_for_secs() {
    let rule = memory(120, 1800);
    let mut r = Run::new(vec![rule.clone()]);
    r.run_to(600, mem(90.0));
    assert_eq!(r.fired(), [120], "{:?}", r.events);
    assert_eq!(
        *r.alerts()[0],
        Event {
            ts_ms: T0 + 120 * S,
            start_ms: T0,
            processes: vec![],
            detail: EventDetail::Alert {
                rule_id: rule.id,
                rule_name: rule.name,
                cause: AlertCause::Threshold {
                    metric: MetricId::from_static("mem.pressure"),
                    labels: Labels::new(),
                    value: 90.0,
                    op: Cmp::Gt,
                    threshold: 80.0,
                    for_secs: 120,
                },
            },
        }
    );
}

#[test]
fn zero_for_secs_fires_on_the_first_satisfying_reading() {
    let mut r = Run::new(vec![memory(0, 1800)]);
    r.run_to(10, mem(50.0));
    r.run_to(30, mem(90.0));
    assert_eq!(r.fired(), [10]);
}

#[test]
fn a_failing_reading_before_the_hold_completes_restarts_it() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.run_to(100, mem(90.0));
    r.run_to(101, mem(70.0));
    r.run_to(400, mem(90.0));
    assert_eq!(r.fired(), [221]);
}

/// A tick without a reading is neither a failing reading nor a held one: the hold
/// carries on, and it cannot complete on that tick.
#[test]
fn a_missing_reading_neither_holds_nor_clears() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.run_to(120, mem(90.0));
    r.run_to(121, mem(f32::NAN));
    r.run_to(200, mem(90.0));
    assert_eq!(r.fired(), [121]);
}

/// Six seconds without a reading at a 1 s period is a hole: the hold starts over.
#[test]
fn a_series_silent_for_more_than_three_periods_is_cleared() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.run_to(60, mem(90.0));
    r.run_to(65, mem(f32::NAN));
    r.run_to(400, mem(90.0));
    assert_eq!(r.fired(), [185]);
}

/// Tray-only, the series reads every 10 s; a window opens at 60 s and it reads every
/// second. The 10 s spacing before the change is normal for the period the series had
/// at its last reading, so the hold that began at 0 s carries on.
#[test]
fn a_hold_survives_the_cadence_dropping_from_ten_seconds_to_one() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.periods[MEM] = 10_000;
    r.run_to(60, |sec| {
        let v = if sec % 10 == 0 { 90.0 } else { f32::NAN };
        vec![(MEM, v)]
    });
    r.periods[MEM] = 1000;
    r.run_to(300, mem(90.0));
    assert_eq!(r.fired(), [120]);
    assert_eq!(r.alerts()[0].start_ms, T0);
}

#[test]
fn does_not_fire_again_while_the_condition_stays_met_past_the_cooldown() {
    let mut r = Run::new(vec![memory(120, 60)]);
    r.run_to(1200, mem(90.0));
    assert_eq!(r.fired(), [120]);
}

#[test]
fn fires_again_after_clearing_and_holding_again_once_cooled() {
    let mut r = Run::new(vec![memory(60, 300)]);
    r.run_to(100, mem(90.0));
    r.run_to(400, mem(70.0));
    r.run_to(600, mem(90.0));
    assert_eq!(r.fired(), [60, 460]);
}

/// The second episode completes its hold at 170 s, inside the cooldown that runs to
/// 360 s. It is spent: the rule does not fire when the cooldown ends.
#[test]
fn a_hold_that_completes_inside_the_cooldown_is_spent() {
    let mut r = Run::new(vec![memory(60, 300)]);
    r.run_to(100, mem(90.0));
    r.run_to(110, mem(70.0));
    r.run_to(1000, mem(90.0));
    assert_eq!(r.fired(), [60]);
}

#[test]
fn a_below_rule_fires_under_its_threshold_only() {
    let rule = custom(2, "battery.charge", Labels::new(), Cmp::Lt, 20.0, 0, 1800);
    let mut r = Run::new(vec![rule]);
    r.run_to(10, |_| vec![(BATTERY, 20.0)]);
    r.run_to(20, |_| vec![(BATTERY, 15.0)]);
    assert_eq!(r.fired(), [10]);
    let EventDetail::Alert { cause, .. } = &r.alerts()[0].detail else {
        panic!("an alert")
    };
    assert_eq!(
        *cause,
        AlertCause::Threshold {
            metric: MetricId::from_static("battery.charge"),
            labels: Labels::new(),
            value: 15.0,
            op: Cmp::Lt,
            threshold: 20.0,
            for_secs: 0,
        }
    );
}

/// "Any fan": fan 1 goes over at 10 s, fan 0 at 20 s. The first to hold fires, named.
#[test]
fn a_selector_matching_several_series_fires_for_the_first_to_hold() {
    let rule = custom(3, "fan.rpm", Labels::new(), Cmp::Gt, 4000.0, 60, 1800);
    let mut r = Run::new(vec![rule]);
    r.run_to(300, |sec| {
        let fan0 = if sec >= 20 { 5000.0 } else { 3000.0 };
        let fan1 = if sec >= 10 { 5000.0 } else { 3000.0 };
        vec![(FAN0, fan0), (FAN1, fan1)]
    });
    assert_eq!(r.fired(), [70]);
    let e = r.alerts()[0];
    assert_eq!(e.start_ms, T0 + 10 * S);
    let EventDetail::Alert { cause, .. } = &e.detail else {
        panic!("an alert")
    };
    assert!(
        matches!(cause, AlertCause::Threshold { labels, value, .. }
            if *labels == Labels::single("fan", "1") && *value == 5000.0),
        "{cause:?}"
    );
}

/// A rule on a metric this layout lacks binds to nothing; the rule beside it still
/// fires.
#[test]
fn a_selector_matching_nothing_never_fires() {
    let gpu = custom(4, "gpu.util", Labels::new(), Cmp::Gt, 1.0, 0, 1800);
    let memory = memory(0, 1800);
    let mut r = Run::new(vec![gpu, memory.clone()]);
    r.run_to(60, mem(90.0));
    let ids: Vec<Uuid> = r
        .alerts()
        .iter()
        .filter_map(|e| match &e.detail {
            EventDetail::Alert { rule_id, .. } => Some(*rule_id),
            _ => None,
        })
        .collect();
    assert_eq!(ids, [memory.id]);
}

#[test]
fn a_reset_forgets_progress() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.run_to(100, mem(90.0));
    r.d.reset();
    r.run_to(400, mem(90.0));
    assert_eq!(r.fired(), [220]);
}

/// A sleep inside a reported episode, within the cooldown: the condition still met
/// afterwards is the episode already reported. It fires again only after clearing.
#[test]
fn a_reported_episode_still_met_after_a_reset_is_not_reported_again() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.run_to(200, mem(90.0));
    r.d.reset();
    r.run_to(2500, mem(90.0));
    assert_eq!(r.fired(), [120]);
    r.run_to(2510, mem(70.0));
    r.run_to(2700, mem(90.0));
    assert_eq!(r.fired(), [120, 2630]);
}

/// A rule switched off sees nothing: switched on at 100 s, its hold starts then.
#[test]
fn a_disabled_rule_sees_no_input() {
    let off = AlertRule {
        enabled: false,
        ..memory(120, 1800)
    };
    let mut r = Run::new(vec![off]);
    r.run_to(100, mem(90.0));
    assert_eq!(r.fired(), [] as [i64; 0]);
    r.d.set_alerts(&settings(vec![memory(120, 1800)]));
    r.run_to(400, mem(90.0));
    assert_eq!(r.fired(), [220]);
}

// ---- set_alerts --------------------------------------------------------------------

#[test]
fn an_unchanged_rule_keeps_its_progress() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.run_to(60, mem(90.0));
    r.d.set_alerts(&settings(vec![memory(120, 1800)]));
    r.run_to(300, mem(90.0));
    assert_eq!(r.fired(), [120]);
}

#[test]
fn a_changed_definition_restarts_progress() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.run_to(60, mem(90.0));
    let lower = custom(1, "mem.pressure", Labels::new(), Cmp::Gt, 70.0, 120, 1800);
    r.d.set_alerts(&settings(vec![lower]));
    r.run_to(400, mem(90.0));
    assert_eq!(r.fired(), [180]);
}

/// Fired at 120 s; edited at 130 s. The new definition holds from 140 s, which would
/// complete at 260 s, inside the cooldown the edit kept.
#[test]
fn a_changed_definition_keeps_its_cooldown() {
    let mut r = Run::new(vec![memory(120, 1800)]);
    r.run_to(130, mem(90.0));
    let lower = custom(1, "mem.pressure", Labels::new(), Cmp::Gt, 70.0, 120, 1800);
    r.d.set_alerts(&settings(vec![lower]));
    r.run_to(140, mem(50.0));
    r.run_to(600, mem(90.0));
    assert_eq!(r.fired(), [120]);
}

#[test]
fn a_removed_rule_stops_firing() {
    let mut r = Run::new(vec![memory(120, 60)]);
    r.run_to(130, mem(90.0));
    assert_eq!(r.fired(), [120]);
    r.d.set_alerts(&settings(vec![]));
    r.run_to(140, mem(70.0));
    r.run_to(600, mem(90.0));
    assert_eq!(r.fired(), [120]);
}

#[test]
fn a_new_rule_is_bound_to_the_current_layout_at_once() {
    let mut r = Run::new(vec![]);
    r.run_to(30, mem(90.0));
    r.d.set_alerts(&settings(vec![memory(120, 1800)]));
    r.run_to(300, mem(90.0));
    assert_eq!(r.fired(), [150]);
}

/// After a restart, the custom rule's stored alert from five minutes ago holds it off;
/// without it, the rule fires once.
#[test]
fn seeded_alert_history_holds_a_custom_rule_off_after_a_restart() {
    let rule = memory(0, 1800);
    let stored = Event {
        ts_ms: T0 - 5 * MIN,
        start_ms: T0 - 7 * MIN,
        processes: vec![],
        detail: EventDetail::Alert {
            rule_id: rule.id,
            rule_name: rule.name.clone(),
            cause: AlertCause::Threshold {
                metric: MetricId::from_static("mem.pressure"),
                labels: Labels::new(),
                value: 91.0,
                op: Cmp::Gt,
                threshold: 80.0,
                for_secs: 0,
            },
        },
    };
    let fired = |seed: &[Event]| {
        let mut r = Run::new(vec![rule.clone()]);
        r.d.seed_alert_history(seed);
        r.run_to(600, mem(90.0));
        r.fired().len()
    };
    assert_eq!(fired(&[stored]), 0);
    assert_eq!(fired(&[]), 1);
}

#[test]
fn alert_history_covers_the_longest_cooldown_of_any_rule() {
    assert_eq!(alert_history_ms(&AlertSettings::default()), 30 * MIN);
    assert_eq!(alert_history_ms(&settings(vec![memory(0, 60)])), 30 * MIN);
    assert_eq!(
        alert_history_ms(&settings(vec![memory(0, 60), memory(0, 86_400)])),
        24 * 60 * MIN
    );
}
