//! Rule sentences and notification text for alerts: what a custom rule reads as, what a
//! fired alert's notification says, and the confirmation posted when rules switch on.

use crate::units::format_value;
use statglass_schema::settings::UnitSettings;
use statglass_schema::{
    AlertCause, AlertRule, AlertSettings, Cmp, Condition, Event, EventDetail, Labels, ThermalState,
    alert_metric, series_name,
};

/// Durations shorter than this read in seconds, longer ones in whole minutes.
const SECONDS_BELOW: u32 = 120;
const MS_PER_MINUTE: i64 = 60_000;
const ALERTS_ON_TITLE: &str = "Alerts are on";
const TIMELINE_HINT: &str = "Open StatGlass's Timeline to see what else was running.";

/// A notification's title and body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlertText {
    pub title: String,
    pub body: String,
}

/// A custom rule as one sentence: the metric's label, the series in parentheses when
/// the rule watches one ([`statglass_schema::series_name`]), "above" or "below", the
/// threshold in the user's units, and " for <duration>" unless `for_secs` is 0:
/// "Memory pressure above 80% for 2 min", "Free disk space (/) below 20 GB". A rule
/// that is not a threshold rule (a built-in one) reads as its name.
pub fn rule_summary(rule: &AlertRule, units: &UnitSettings) -> String {
    let Condition::Threshold { series, op, value } = &rule.when else {
        return rule.name.clone();
    };
    let metric = series.metric.as_str();
    format!(
        "{} {} {}{}",
        series_label(metric, &series.labels),
        comparison(*op),
        format_value(metric, *value, units),
        held_for(rule.for_secs),
    )
}

/// Title and body of the notification for an `alert` event, `None` for any other
/// event. A threshold alert is titled with the rule name, its body reads
/// "<label> <value> · <comparison> <threshold> for <duration>".
pub fn alert_text(event: &Event, units: &UnitSettings) -> Option<AlertText> {
    let EventDetail::Alert {
        cause, rule_name, ..
    } = &event.detail
    else {
        return None;
    };
    Some(match cause {
        AlertCause::ProcessCpu { process, cpu_pct } => process_text(event, process, *cpu_pct),
        AlertCause::ThermalState { state } => AlertText {
            title: format!("Thermal state: {}", thermal_label(*state)),
            body: "macOS is reducing performance to cool the Mac down.".to_owned(),
        },
        AlertCause::Threshold {
            metric,
            labels,
            value,
            op,
            threshold,
            for_secs,
        } => {
            let held = ThresholdHeld {
                metric: metric.as_str(),
                labels,
                value: *value,
                op: *op,
                threshold: *threshold,
                for_secs: *for_secs,
            };
            AlertText {
                title: rule_name.clone(),
                body: threshold_body(&held, units),
            }
        }
    })
}

/// What a threshold alert reports: the series, its value, and the rule it broke.
struct ThresholdHeld<'a> {
    metric: &'a str,
    labels: &'a Labels,
    value: f32,
    op: Cmp,
    threshold: f32,
    for_secs: u32,
}

/// "<label> <value> · <comparison> <threshold>[ for <duration>]".
fn threshold_body(held: &ThresholdHeld<'_>, units: &UnitSettings) -> String {
    format!(
        "{} {} · {} {}{}",
        series_label(held.metric, held.labels),
        format_value(held.metric, held.value, units),
        comparison(held.op),
        format_value(held.metric, held.threshold, units),
        held_for(held.for_secs),
    )
}

/// The one-off confirmation for rules just switched on, `None` for none. Built-in rules
/// read as "when ..." clauses; custom rules follow by their summary, as "for: ..." on
/// their own or "Also for: ..." after the built-in sentence.
pub fn alerts_on_text(rules: &[AlertRule], units: &UnitSettings) -> Option<AlertText> {
    let summaries: Vec<String> = rules
        .iter()
        .filter(|rule| matches!(rule.when, Condition::Threshold { .. }))
        .map(|rule| rule_summary(rule, units))
        .collect();
    let body = match (builtin_clauses(rules), summaries.is_empty()) {
        (None, true) => return None,
        (None, false) => format!("You'll get a notification for: {}.", summaries.join("; ")),
        (Some(when), true) => format!("You'll get a notification when {when}."),
        (Some(when), false) => format!(
            "You'll get a notification when {when}. Also for: {}.",
            summaries.join("; ")
        ),
    };
    Some(AlertText {
        title: ALERTS_ON_TITLE.to_owned(),
        body,
    })
}

/// The clauses of the built-in rules among `rules`, joined as "a, when b or when c",
/// `None` when there are none.
fn builtin_clauses(rules: &[AlertRule]) -> Option<String> {
    let clauses: Vec<String> = rules.iter().filter_map(builtin_clause).collect();
    match clauses.as_slice() {
        [] => None,
        [one] => Some(one.clone()),
        [init @ .., last] => Some(format!("{} or when {last}", init.join(", when "))),
    }
}

/// What a built-in rule waits for, as the end of "You'll get a notification when ...",
/// `None` for a custom threshold rule.
fn builtin_clause(rule: &AlertRule) -> Option<String> {
    Some(match &rule.when {
        Condition::ProcessCpuAbove { percent_of_core } => {
            let minutes = rule.for_secs / 60;
            format!(
                "a process stays above {percent_of_core:.0}% CPU for {minutes} {}",
                if minutes == 1 { "minute" } else { "minutes" }
            )
        }
        Condition::ThermalStateAtLeast(ThermalState::Critical) => {
            "the thermal state reaches Critical".to_owned()
        }
        Condition::ThermalStateAtLeast(level) => {
            format!(
                "the thermal state reaches {} or worse",
                thermal_label(*level)
            )
        }
        Condition::Threshold { .. } => return None,
    })
}

/// The notification for a process CPU alert. One alert names every process whose run
/// completed on that tick, hottest first (`process` is the hottest).
fn process_text(event: &Event, process: &str, cpu_pct: f32) -> AlertText {
    let minutes = (event.ts_ms - event.start_ms) / MS_PER_MINUTE;
    let others: Vec<&str> = event
        .processes
        .iter()
        .map(String::as_str)
        .filter(|other| *other != process)
        .collect();
    // A rule id this build does not know (a newer build's rule) has no threshold to name.
    let (held, also) = match builtin_cpu_threshold(event) {
        Some(t) => (
            format!("Above {t:.0}% for {minutes} minutes."),
            format!("Also above {t:.0}%"),
        ),
        None => (
            format!("For {minutes} minutes."),
            "Also running hot".to_owned(),
        ),
    };
    let also = if others.is_empty() {
        String::new()
    } else {
        format!(" {also}: {}.", others.join(", "))
    };
    AlertText {
        title: format!("{process} is using {cpu_pct:.0}% CPU"),
        body: format!("{held}{also} {TIMELINE_HINT}"),
    }
}

/// The CPU threshold of the built-in rule that fired `event`, when it is a process CPU
/// rule.
fn builtin_cpu_threshold(event: &Event) -> Option<f32> {
    let EventDetail::Alert { rule_id, .. } = &event.detail else {
        return None;
    };
    AlertSettings::default()
        .builtin_rules()
        .into_iter()
        .find(|rule| rule.id == *rule_id)
        .and_then(|rule| match rule.when {
            Condition::ProcessCpuAbove { percent_of_core } => Some(percent_of_core),
            _ => None,
        })
}

/// The metric's label, with the watched series in parentheses when there is one:
/// "Fan speed (Fan 1)". A metric missing from `ALERT_METRICS` reads as its id.
fn series_label(metric: &str, labels: &Labels) -> String {
    let label = alert_metric(metric).map_or(metric, |m| m.label);
    match series_name(metric, labels) {
        Some(name) => format!("{label} ({name})"),
        None => label.to_owned(),
    }
}

fn comparison(op: Cmp) -> &'static str {
    match op {
        Cmp::Gt | Cmp::Ge => "above",
        Cmp::Lt | Cmp::Le => "below",
    }
}

/// " for <duration>", or nothing for a rule that fires on the first reading.
fn held_for(for_secs: u32) -> String {
    match for_secs {
        0 => String::new(),
        secs if secs < SECONDS_BELOW => format!(" for {secs} s"),
        secs => format!(" for {} min", secs / 60),
    }
}

fn thermal_label(state: ThermalState) -> &'static str {
    match state {
        ThermalState::Nominal => "Nominal",
        ThermalState::Fair => "Fair",
        ThermalState::Serious => "Serious",
        ThermalState::Critical => "Critical",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// From two minutes on, a duration reads in whole minutes rounded down.
    #[test]
    fn durations_from_two_minutes_read_in_whole_minutes_rounded_down() {
        assert_eq!(held_for(150), " for 2 min");
        assert_eq!(held_for(119), " for 119 s");
        assert_eq!(held_for(0), "");
    }
}
