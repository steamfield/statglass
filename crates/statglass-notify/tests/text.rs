//! What rules and alerts say: rule sentences, notification titles and bodies, and
//! values in the user's units. The process and thermal wording is unchanged from the
//! app shell's notifications before custom rules.

use statglass_notify::{AlertText, alert_text, alerts_on_text, format_value, rule_summary};
use statglass_schema::settings::{MemoryUnit, NetworkUnit, TemperatureUnit, UnitSettings};
use statglass_schema::{
    AlertCause, AlertRule, Cmp, Condition, Event, EventDetail, Labels, MetricId, SeriesSelector,
    ThermalState,
};
use uuid::Uuid;

const CELSIUS_DECIMAL: UnitSettings = UnitSettings {
    temperature: TemperatureUnit::Celsius,
    network: NetworkUnit::BytesPerSec,
    memory: MemoryUnit::Decimal,
};

const FAHRENHEIT_BINARY: UnitSettings = UnitSettings {
    temperature: TemperatureUnit::Fahrenheit,
    network: NetworkUnit::BytesPerSec,
    memory: MemoryUnit::Binary,
};

fn rule(metric: &'static str, labels: Labels, op: Cmp, value: f32, for_secs: u32) -> AlertRule {
    AlertRule {
        id: Uuid::from_u128(0xa1e7),
        name: "My rule".into(),
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: MetricId::from_static(metric),
                labels,
            },
            op,
            value,
        },
        for_secs,
        cooldown_secs: 1800,
        enabled: true,
    }
}

fn summary(metric: &'static str, op: Cmp, value: f32, for_secs: u32) -> String {
    rule_summary(
        &rule(metric, Labels::new(), op, value, for_secs),
        &CELSIUS_DECIMAL,
    )
}

/// The "Alerts are on" confirmation.
fn text(title: &str, body: &str) -> Option<AlertText> {
    Some(AlertText {
        title: title.into(),
        body: body.into(),
        rule: None,
        kind: "alerts_on",
    })
}

/// A fired alert of `kind` from the rule named by [`alert`].
fn fired(kind: &'static str, title: &str, body: &str) -> Option<AlertText> {
    Some(AlertText {
        title: title.into(),
        body: body.into(),
        rule: Some("Memory is tight".into()),
        kind,
    })
}

fn alert(rule_id: Uuid, processes: &[&str], cause: AlertCause) -> Event {
    Event {
        ts_ms: 400_000,
        start_ms: 100_000,
        processes: processes.iter().map(|p| (*p).to_owned()).collect(),
        detail: EventDetail::Alert {
            rule_id,
            rule_name: "Memory is tight".into(),
            cause,
        },
    }
}

fn threshold(
    metric: &'static str,
    labels: Labels,
    value: f32,
    op: Cmp,
    threshold: f32,
    for_secs: u32,
) -> Event {
    alert(
        Uuid::from_u128(0xa1e7),
        &[],
        AlertCause::Threshold {
            metric: MetricId::from_static(metric),
            labels,
            value,
            op,
            threshold,
            for_secs,
        },
    )
}

fn hot(processes: &[&str], rule_id: Uuid) -> Event {
    alert(
        rule_id,
        processes,
        AlertCause::ProcessCpu {
            process: processes[0].into(),
            cpu_pct: 251.4,
        },
    )
}

// ---- rule_summary ------------------------------------------------------------------

#[test]
fn summary_reads_above_for_gt_and_ge() {
    assert_eq!(
        summary("mem.pressure", Cmp::Gt, 80.0, 120),
        "Memory pressure above 80% for 2 min"
    );
    assert_eq!(
        summary("mem.pressure", Cmp::Ge, 80.0, 120),
        "Memory pressure above 80% for 2 min"
    );
}

#[test]
fn summary_reads_below_for_lt_and_le() {
    assert_eq!(
        summary("battery.charge", Cmp::Lt, 20.0, 300),
        "Battery charge below 20% for 5 min"
    );
    assert_eq!(
        summary("battery.charge", Cmp::Le, 20.0, 300),
        "Battery charge below 20% for 5 min"
    );
}

#[test]
fn summary_leaves_out_a_zero_duration() {
    assert_eq!(
        summary("battery.charge", Cmp::Lt, 20.0, 0),
        "Battery charge below 20%"
    );
}

#[test]
fn summary_counts_durations_under_two_minutes_in_seconds() {
    assert_eq!(
        summary("cpu.total", Cmp::Gt, 90.0, 30),
        "CPU usage above 90% for 30 s"
    );
    assert_eq!(
        summary("cpu.total", Cmp::Gt, 90.0, 60),
        "CPU usage above 90% for 60 s"
    );
    assert_eq!(
        summary("cpu.total", Cmp::Gt, 90.0, 120),
        "CPU usage above 90% for 2 min"
    );
}

#[test]
fn summary_names_the_series_a_labelled_rule_watches() {
    let fan = rule("fan.rpm", Labels::single("fan", "0"), Cmp::Gt, 4000.0, 0);
    assert_eq!(
        rule_summary(&fan, &CELSIUS_DECIMAL),
        "Fan speed (Fan 1) above 4,000 rpm"
    );
    let disk = rule("disk.free", Labels::single("vol", "/"), Cmp::Lt, 20e9, 0);
    assert_eq!(
        rule_summary(&disk, &CELSIUS_DECIMAL),
        "Free disk space (/) below 20 GB"
    );
    let any_fan = rule("fan.rpm", Labels::new(), Cmp::Gt, 4000.0, 120);
    assert_eq!(
        rule_summary(&any_fan, &CELSIUS_DECIMAL),
        "Fan speed above 4,000 rpm for 2 min"
    );
}

/// Memory follows the memory unit; disk space is always decimal GB, as Finder shows it.
#[test]
fn summary_bytes_follow_the_memory_unit_for_memory_only() {
    let swap = rule("mem.swap_used", Labels::new(), Cmp::Gt, 4e9, 300);
    assert_eq!(
        rule_summary(&swap, &CELSIUS_DECIMAL),
        "Swap used above 4 GB for 5 min"
    );
    assert_eq!(
        rule_summary(&swap, &FAHRENHEIT_BINARY),
        "Swap used above 3.7 GiB for 5 min"
    );
    let disk = rule("disk.free", Labels::single("vol", "/"), Cmp::Lt, 20e9, 0);
    assert_eq!(
        rule_summary(&disk, &FAHRENHEIT_BINARY),
        "Free disk space (/) below 20 GB"
    );
}

#[test]
fn summary_temperatures_follow_the_temperature_unit() {
    let hot = rule("thermal.hottest", Labels::new(), Cmp::Gt, 95.0, 120);
    assert_eq!(
        rule_summary(&hot, &CELSIUS_DECIMAL),
        "Hottest sensor above 95 °C for 2 min"
    );
    assert_eq!(
        rule_summary(&hot, &FAHRENHEIT_BINARY),
        "Hottest sensor above 203 °F for 2 min"
    );
}

/// A metric missing from `ALERT_METRICS` (a rule from a newer build) is named by its
/// catalog id.
#[test]
fn summary_falls_back_to_the_metric_id() {
    assert_eq!(
        summary("cpu.user", Cmp::Gt, 50.0, 120),
        "cpu.user above 50% for 2 min"
    );
}

// ---- format_value ------------------------------------------------------------------

#[test]
fn values_take_the_catalog_unit_in_the_users_terms() {
    let v = |metric, value| format_value(metric, value, &CELSIUS_DECIMAL);
    assert_eq!(v("mem.pressure", 84.4), "84%");
    assert_eq!(v("power.system", 7.5), "7.5 W");
    assert_eq!(v("power.system", 72.4), "72 W");
    assert_eq!(v("fan.rpm", 12_500.0), "12,500 rpm");
    assert_eq!(v("mem.swap_out", 1250.0), "1,250 pages/s");
    assert_eq!(v("thermal.hottest", 97.0), "97 °C");
    assert_eq!(v("disk.free", 12.3e9), "12.3 GB");
    assert_eq!(
        format_value("thermal.hottest", 97.0, &FAHRENHEIT_BINARY),
        "207 °F"
    );
    assert_eq!(
        format_value("mem.swap_used", 5e9, &FAHRENHEIT_BINARY),
        "4.7 GiB"
    );
}

// ---- alert_text --------------------------------------------------------------------

#[test]
fn threshold_alert_is_titled_with_the_rule_and_says_what_held() {
    let e = threshold("mem.pressure", Labels::new(), 84.2, Cmp::Gt, 80.0, 120);
    assert_eq!(
        alert_text(&e, &CELSIUS_DECIMAL),
        fired(
            "threshold",
            "Memory is tight",
            "Memory pressure 84% · above 80% for 2 min"
        )
    );
}

#[test]
fn threshold_alert_without_a_duration_leaves_it_out() {
    let e = threshold("battery.charge", Labels::new(), 15.0, Cmp::Lt, 20.0, 0);
    assert_eq!(
        alert_text(&e, &CELSIUS_DECIMAL),
        fired(
            "threshold",
            "Memory is tight",
            "Battery charge 15% · below 20%"
        )
    );
}

#[test]
fn threshold_alert_names_the_series_and_uses_the_users_units() {
    let disk = threshold(
        "disk.free",
        Labels::single("vol", "/"),
        12.3e9,
        Cmp::Lt,
        20e9,
        0,
    );
    assert_eq!(
        alert_text(&disk, &FAHRENHEIT_BINARY),
        fired(
            "threshold",
            "Memory is tight",
            "Free disk space (/) 12.3 GB · below 20 GB"
        )
    );
    let fan = threshold(
        "fan.rpm",
        Labels::single("fan", "1"),
        5200.0,
        Cmp::Gt,
        4000.0,
        120,
    );
    assert_eq!(
        alert_text(&fan, &CELSIUS_DECIMAL),
        fired(
            "threshold",
            "Memory is tight",
            "Fan speed (Fan 2) 5,200 rpm · above 4,000 rpm for 2 min"
        )
    );
    let temp = threshold("thermal.hottest", Labels::new(), 97.0, Cmp::Gt, 95.0, 120);
    assert_eq!(
        alert_text(&temp, &FAHRENHEIT_BINARY),
        fired(
            "threshold",
            "Memory is tight",
            "Hottest sensor 207 °F · above 203 °F for 2 min"
        )
    );
}

#[test]
fn process_alert_text_is_unchanged() {
    assert_eq!(
        alert_text(
            &hot(&["ffmpeg"], AlertRule::hot_process().id),
            &CELSIUS_DECIMAL
        ),
        fired(
            "process_cpu",
            "ffmpeg is using 251% CPU",
            "Above 200% for 5 minutes. Open StatGlass's Timeline to see what else was running."
        )
    );
}

/// The threshold comes from the rule that fired, not a literal; a rule this build does
/// not know names none. Every process of one alert is named.
#[test]
fn process_alert_names_the_rules_threshold_and_every_process() {
    let Condition::ProcessCpuAbove { percent_of_core } = AlertRule::hot_process().when else {
        panic!("hot_process is a process CPU rule")
    };
    let two = alert_text(
        &hot(&["ffmpeg", "x264"], AlertRule::hot_process().id),
        &CELSIUS_DECIMAL,
    );
    assert_eq!(
        two.map(|t| t.body),
        Some(format!(
            "Above {percent_of_core:.0}% for 5 minutes. Also above {percent_of_core:.0}%: \
             x264. Open StatGlass's Timeline to see what else was running."
        ))
    );
    let unknown = alert_text(&hot(&["ffmpeg"], Uuid::from_u128(99)), &CELSIUS_DECIMAL);
    assert_eq!(
        unknown.map(|t| t.body),
        Some("For 5 minutes. Open StatGlass's Timeline to see what else was running.".into())
    );
}

#[test]
fn thermal_alert_text_is_unchanged() {
    let e = alert(
        AlertRule::thermal_serious().id,
        &[],
        AlertCause::ThermalState {
            state: ThermalState::Critical,
        },
    );
    assert_eq!(
        alert_text(&e, &CELSIUS_DECIMAL),
        fired(
            "thermal_state",
            "Thermal state: Critical",
            "macOS is reducing performance to cool the Mac down."
        )
    );
}

#[test]
fn non_alert_events_have_no_text() {
    let e = Event {
        detail: EventDetail::ThermalState {
            from: None,
            to: ThermalState::Serious,
        },
        ..hot(&["ffmpeg"], AlertRule::hot_process().id)
    };
    assert_eq!(alert_text(&e, &CELSIUS_DECIMAL), None);
}

// ---- alerts_on_text ----------------------------------------------------------------

#[test]
fn alerts_on_text_says_what_the_builtin_rules_will_notify() {
    assert_eq!(alerts_on_text(&[], false, &CELSIUS_DECIMAL), None);
    assert_eq!(
        alerts_on_text(&[AlertRule::thermal_serious()], false, &CELSIUS_DECIMAL),
        text(
            "Alerts are on",
            "You'll get a notification when the thermal state reaches Serious or worse."
        )
    );
    assert_eq!(
        alerts_on_text(
            &[AlertRule::hot_process(), AlertRule::thermal_serious()],
            false,
            &CELSIUS_DECIMAL
        )
        .map(|t| t.body),
        Some(
            "You'll get a notification when a process stays above 200% CPU for 5 minutes \
             or when the thermal state reaches Serious or worse."
                .into()
        )
    );
}

/// Custom rules are listed by their summary after "for:", separated by "; ". With a
/// built-in rule, the built-in sentence comes first and the custom rules follow as
/// "Also for: ...".
#[test]
fn alerts_on_text_lists_custom_rules_by_summary() {
    let memory = rule("mem.pressure", Labels::new(), Cmp::Gt, 80.0, 120);
    let battery = rule("battery.charge", Labels::new(), Cmp::Lt, 20.0, 0);
    assert_eq!(
        alerts_on_text(std::slice::from_ref(&memory), false, &CELSIUS_DECIMAL),
        text(
            "Alerts are on",
            "You'll get a notification for: Memory pressure above 80% for 2 min."
        )
    );
    assert_eq!(
        alerts_on_text(&[memory.clone(), battery], false, &CELSIUS_DECIMAL).map(|t| t.body),
        Some(
            "You'll get a notification for: Memory pressure above 80% for 2 min; \
             Battery charge below 20%."
                .into()
        )
    );
    assert_eq!(
        alerts_on_text(
            &[AlertRule::thermal_serious(), memory],
            false,
            &CELSIUS_DECIMAL
        )
        .map(|t| t.body),
        Some(
            "You'll get a notification when the thermal state reaches Serious or worse. \
             Also for: Memory pressure above 80% for 2 min."
                .into()
        )
    );
}

/// Host offline reads as a "when" clause of its own, after the built-in rules.
#[test]
fn alerts_on_text_says_when_a_saved_host_is_offline() {
    assert_eq!(
        alerts_on_text(&[], true, &CELSIUS_DECIMAL),
        text(
            "Alerts are on",
            "You'll get a notification when a saved host is offline for 5 minutes."
        )
    );
    let memory = rule("mem.pressure", Labels::new(), Cmp::Gt, 80.0, 120);
    assert_eq!(
        alerts_on_text(
            &[AlertRule::thermal_serious(), memory],
            true,
            &CELSIUS_DECIMAL
        )
        .map(|t| t.body),
        Some(
            "You'll get a notification when the thermal state reaches Serious or worse \
             or when a saved host is offline for 5 minutes. \
             Also for: Memory pressure above 80% for 2 min."
                .into()
        )
    );
}

/// Swap-out rate reads in pages per second.
#[test]
fn summary_for_the_swap_out_rate() {
    assert_eq!(
        summary("mem.swap_out", Cmp::Gt, 1000.0, 120),
        "Swapping out above 1,000 pages/s for 2 min"
    );
}
