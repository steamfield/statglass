//! Alert rules as plain data (architecture.md infra 7). Rules evaluate inside the engine,
//! so the same rule runs locally (v1.2) and on a remote agent (v4). Two rules are
//! built in, [`AlertRule::hot_process`] and [`AlertRule::thermal_serious`], each
//! switched on in settings ([`crate::settings::AlertSettings`]). Users add custom
//! threshold rules on the metrics in [`crate::ALERT_METRICS`]; a custom rule must pass
//! [`AlertRule::validate_custom`] before it is saved (plan/rfc-alerts.md).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::alert_metrics::alert_metric;
use crate::catalog::Catalog;
use crate::series::{Labels, SeriesSelector};

const HOT_PROCESS_ID: Uuid = Uuid::from_u128(0x6b65_6c76_6f00_0000_0000_0000_0000_0001);
const THERMAL_SERIOUS_ID: Uuid = Uuid::from_u128(0x6b65_6c76_6f00_0000_0000_0000_0000_0002);

/// The fan speed metric and its label, whose values number fans from 0.
const FAN_METRIC: &str = "fan.rpm";
const FAN_LABEL: &str = "fan";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct AlertRule {
    pub id: Uuid,
    pub name: String,
    pub when: Condition,
    /// How long the condition must hold before the rule fires.
    pub for_secs: u32,
    /// Minimum time between two firings.
    pub cooldown_secs: u32,
    pub enabled: bool,
}

impl AlertRule {
    /// The ids of the built-in rules. A custom rule may not use one.
    pub const BUILTIN_IDS: [Uuid; 2] = [HOT_PROCESS_ID, THERMAL_SERIOUS_ID];
    /// The most custom rules one settings file holds.
    pub const MAX_CUSTOM: usize = 32;
    /// The longest `for_secs` a custom rule may wait: one hour.
    pub const MAX_FOR_SECS: u32 = 3600;
    /// The shortest cooldown a custom rule may have: one minute.
    pub const MIN_COOLDOWN_SECS: u32 = 60;
    /// The longest cooldown a custom rule may have: 24 hours.
    pub const MAX_COOLDOWN_SECS: u32 = 86_400;
    /// The longest custom rule name, in characters after trimming.
    pub const MAX_NAME_CHARS: usize = 60;

    /// Built-in: a process above 200% CPU for 5 minutes.
    pub fn hot_process() -> Self {
        Self {
            id: HOT_PROCESS_ID,
            name: "Process above 200% CPU for 5 minutes".into(),
            when: Condition::ProcessCpuAbove {
                percent_of_core: 200.0,
            },
            for_secs: 300,
            cooldown_secs: 1800,
            enabled: false,
        }
    }

    /// Built-in: thermal state Serious or worse.
    pub fn thermal_serious() -> Self {
        Self {
            id: THERMAL_SERIOUS_ID,
            name: "Thermal state Serious or worse".into(),
            when: Condition::ThermalStateAtLeast(ThermalState::Serious),
            for_secs: 0,
            cooldown_secs: 1800,
            enabled: false,
        }
    }

    /// Checks a user-written rule: a threshold on one metric of [`crate::ALERT_METRICS`],
    /// at most one label the catalog metric carries, a finite value inside the metric's
    /// range, a name of 1 to [`Self::MAX_NAME_CHARS`] characters after trimming,
    /// `for_secs` up to [`Self::MAX_FOR_SECS`], a cooldown between
    /// [`Self::MIN_COOLDOWN_SECS`] and [`Self::MAX_COOLDOWN_SECS`], and an id that is
    /// not a built-in one.
    pub fn validate_custom(&self) -> Result<(), AlertRuleError> {
        if Self::BUILTIN_IDS.contains(&self.id) {
            return Err(AlertRuleError::ReservedId);
        }
        check_name(&self.name)?;
        let Condition::Threshold { series, value, .. } = &self.when else {
            return Err(AlertRuleError::NotThreshold);
        };
        check_threshold(series, *value)?;
        check_timing(self.for_secs, self.cooldown_secs)
    }
}

/// A rule name is 1 to [`AlertRule::MAX_NAME_CHARS`] characters and already trimmed, so
/// the name that is checked is the name that is stored.
fn check_name(name: &str) -> Result<(), AlertRuleError> {
    let chars = name.chars().count();
    if name != name.trim() || chars == 0 || chars > AlertRule::MAX_NAME_CHARS {
        return Err(AlertRuleError::Name);
    }
    Ok(())
}

/// The watched metric is alertable, the selector names at most one label the catalog
/// metric carries, and the value is finite and inside the metric's range.
fn check_threshold(series: &SeriesSelector, value: f32) -> Result<(), AlertRuleError> {
    let metric = series.metric.as_str();
    let Some(alertable) = alert_metric(metric) else {
        return Err(AlertRuleError::Metric(metric.to_owned()));
    };
    if !labels_allowed(metric, &series.labels) {
        return Err(AlertRuleError::Labels);
    }
    let in_range = value.is_finite() && alertable.min <= value && value <= alertable.max;
    if !in_range {
        return Err(AlertRuleError::Value {
            min: alertable.min,
            max: alertable.max,
        });
    }
    Ok(())
}

/// Whether `labels` is empty (every series) or one pair whose key `metric` carries.
fn labels_allowed(metric: &str, labels: &Labels) -> bool {
    if labels.len() > 1 {
        return false;
    }
    let carried = Catalog::builtin()
        .get(metric)
        .map_or(&[][..], |def| def.label_keys);
    labels.keys().all(|key| carried.contains(&key))
}

/// `for_secs` is at most [`AlertRule::MAX_FOR_SECS`] and the cooldown lies between
/// [`AlertRule::MIN_COOLDOWN_SECS`] and [`AlertRule::MAX_COOLDOWN_SECS`].
fn check_timing(for_secs: u32, cooldown_secs: u32) -> Result<(), AlertRuleError> {
    if for_secs > AlertRule::MAX_FOR_SECS {
        return Err(AlertRuleError::Duration);
    }
    let cooldowns = AlertRule::MIN_COOLDOWN_SECS..=AlertRule::MAX_COOLDOWN_SECS;
    if !cooldowns.contains(&cooldown_secs) {
        return Err(AlertRuleError::Cooldown);
    }
    Ok(())
}

/// The display name of one series of `metric` in a rule or an alert: `None` for a
/// series without labels, "Fan {n+1}" for `fan.rpm` with a numeric `fan` label `n`
/// (fans are numbered from 0 in the catalog and from 1 on screen), otherwise the single
/// label's value ("/" for the boot volume).
pub fn series_name(metric: &str, labels: &Labels) -> Option<String> {
    let (key, value) = labels.iter().next()?;
    let fan_index = (metric == FAN_METRIC && key == FAN_LABEL)
        .then(|| value.parse::<u32>().ok())
        .flatten();
    match fan_index {
        Some(n) => Some(format!("Fan {}", n.saturating_add(1))),
        None => Some(value.to_owned()),
    }
}

/// Why a custom rule was refused. Each message states the limit it broke, so the
/// Alerts page can show it as is.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AlertRuleError {
    #[error("rule name must be 1 to 60 characters with no leading or trailing spaces")]
    Name,
    #[error("metric {0:?} cannot be alerted on; choose one of the listed metrics")]
    Metric(String),
    #[error("a rule watches every series of its metric or one series named by a label it carries")]
    Labels,
    /// `min` and `max` are the metric's range in its catalog unit, for callers that
    /// format it in the user's display unit.
    #[error("threshold is outside the range this metric accepts")]
    Value { min: f32, max: f32 },
    #[error("duration must be at most 1 hour")]
    Duration,
    #[error("cooldown must be between 1 minute and 24 hours")]
    Cooldown,
    #[error("rule id belongs to a built-in rule")]
    ReservedId,
    #[error("a custom rule must be a threshold on one metric")]
    NotThreshold,
    #[error("at most 32 custom rules")]
    TooMany,
    #[error("two rules share one id")]
    DuplicateId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    /// Any series matching `series` compared with `value` in the metric's unit.
    Threshold {
        series: SeriesSelector,
        op: Cmp,
        value: f32,
    },
    /// `thermal.state` at or above this level.
    ThermalStateAtLeast(ThermalState),
    /// Any process above this CPU (percent of one core).
    ProcessCpuAbove { percent_of_core: f32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Cmp {
    Gt,
    Ge,
    Lt,
    Le,
}

impl Cmp {
    /// `lhs op rhs`. NaN (a missing value) never satisfies a comparison.
    pub fn eval(self, lhs: f32, rhs: f32) -> bool {
        match self {
            Cmp::Gt => lhs > rhs,
            Cmp::Ge => lhs >= rhs,
            Cmp::Lt => lhs < rhs,
            Cmp::Le => lhs <= rhs,
        }
    }
}

/// `NSProcessInfo.thermalState`, the value of the `thermal.state` metric. Ordered, so
/// `state >= ThermalState::Serious` reads naturally.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ThermalState {
    Nominal = 0,
    Fair = 1,
    Serious = 2,
    Critical = 3,
}

impl ThermalState {
    /// From the metric value (0 to 3). `None` for NaN or anything out of range.
    pub fn from_value(v: f32) -> Option<ThermalState> {
        <Self as crate::MetricCode>::from_value(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::series::MetricId;

    fn rules() -> Vec<AlertRule> {
        let id = |n| Uuid::from_u128(n);
        vec![
            AlertRule {
                id: id(1),
                name: "Hot process".into(),
                when: Condition::ProcessCpuAbove {
                    percent_of_core: 200.0,
                },
                for_secs: 300,
                cooldown_secs: 1800,
                enabled: true,
            },
            AlertRule {
                id: id(2),
                name: "Thermal".into(),
                when: Condition::ThermalStateAtLeast(ThermalState::Serious),
                for_secs: 0,
                cooldown_secs: 600,
                enabled: true,
            },
            AlertRule {
                id: id(3),
                name: "Core 7 pegged".into(),
                when: Condition::Threshold {
                    series: SeriesSelector {
                        metric: MetricId::from_static("cpu.load"),
                        labels: Labels::single("core", "P7"),
                    },
                    op: Cmp::Ge,
                    value: 95.0,
                },
                for_secs: 60,
                cooldown_secs: 60,
                enabled: false,
            },
        ]
    }

    #[test]
    fn round_trips_json() {
        let r = rules();
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<Vec<AlertRule>>(&json).unwrap(), r);
    }

    #[test]
    fn round_trips_cbor() {
        let r = rules();
        let mut buf = Vec::new();
        ciborium::into_writer(&r, &mut buf).unwrap();
        assert_eq!(
            ciborium::from_reader::<Vec<AlertRule>, _>(buf.as_slice()).unwrap(),
            r
        );
    }

    #[test]
    fn condition_json_shape() {
        let c = Condition::ThermalStateAtLeast(ThermalState::Serious);
        assert_eq!(
            serde_json::to_string(&c).unwrap(),
            r#"{"thermal_state_at_least":"serious"}"#
        );
    }

    #[test]
    fn cmp_and_thermal_state() {
        assert!(Cmp::Gt.eval(2.0, 1.0));
        assert!(!Cmp::Gt.eval(f32::NAN, 1.0));
        assert!(!Cmp::Le.eval(f32::NAN, 1.0));
        assert_eq!(ThermalState::from_value(2.0), Some(ThermalState::Serious));
        assert_eq!(ThermalState::from_value(f32::NAN), None);
        assert_eq!(ThermalState::from_value(4.0), None);
        assert!(ThermalState::Critical >= ThermalState::Serious);
    }
}

#[cfg(test)]
#[path = "alert_validation_tests.rs"]
mod validation_tests;

#[cfg(test)]
mod name_tests {
    use super::*;
    use crate::series::MetricId;

    fn named(name: &str) -> AlertRule {
        AlertRule {
            id: Uuid::from_u128(0xa1e7),
            name: name.into(),
            when: Condition::Threshold {
                series: SeriesSelector {
                    metric: MetricId::from_static("mem.pressure"),
                    labels: Labels::new(),
                },
                op: Cmp::Gt,
                value: 80.0,
            },
            for_secs: 120,
            cooldown_secs: 1800,
            enabled: true,
        }
    }

    #[test]
    fn rejects_a_name_with_leading_or_trailing_whitespace() {
        for name in [" Memory", "Memory ", "\tMemory\n"] {
            assert_eq!(
                named(name).validate_custom(),
                Err(AlertRuleError::Name),
                "{name:?}"
            );
        }
    }

    #[test]
    fn accepts_a_trimmed_name_of_60_characters_counted_as_chars() {
        assert_eq!(named(&"é".repeat(60)).validate_custom(), Ok(()));
        assert_eq!(
            named(&"é".repeat(61)).validate_custom(),
            Err(AlertRuleError::Name)
        );
    }

    #[test]
    fn the_name_and_value_messages_state_the_rule_without_raw_numbers() {
        assert_eq!(
            AlertRuleError::Name.to_string(),
            "rule name must be 1 to 60 characters with no leading or trailing spaces"
        );
        let value = AlertRuleError::Value {
            min: 1e8,
            max: 1e14,
        };
        assert_eq!(
            value.to_string(),
            "threshold is outside the range this metric accepts"
        );
    }
}
