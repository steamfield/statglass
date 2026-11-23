//! [`AlertRule::validate_custom`] and [`series_name`]: what a custom rule may say, one
//! test per limit, each with the error the Alerts page shows.

use uuid::Uuid;

use super::*;
use crate::alert_metrics::{ALERT_METRICS, AlertMetric, alert_metric};
use crate::series::{Labels, MetricId};

/// A rule as the Alerts page builds it from a metric's defaults.
fn default_rule(m: &AlertMetric) -> AlertRule {
    let labels = m
        .default_label
        .map_or_else(Labels::new, |(k, v)| Labels::single(k, v));
    AlertRule {
        id: Uuid::from_u128(0xa1e7),
        name: format!("{} alert", m.label),
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: MetricId::from_static(m.metric),
                labels,
            },
            op: m.default_op,
            value: m.default_value,
        },
        for_secs: m.default_for_secs,
        cooldown_secs: 1800,
        enabled: true,
    }
}

fn memory() -> AlertRule {
    default_rule(alert_metric("mem.pressure").unwrap())
}

fn fan() -> AlertRule {
    default_rule(alert_metric("fan.rpm").unwrap())
}

fn with_series(rule: AlertRule, metric: &'static str, labels: Labels) -> AlertRule {
    let Condition::Threshold { op, value, .. } = rule.when else {
        panic!("a threshold rule")
    };
    AlertRule {
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: MetricId::from_static(metric),
                labels,
            },
            op,
            value,
        },
        ..rule
    }
}

fn with_value(rule: AlertRule, v: f32) -> AlertRule {
    let Condition::Threshold { series, op, .. } = rule.when else {
        panic!("a threshold rule")
    };
    AlertRule {
        when: Condition::Threshold {
            series,
            op,
            value: v,
        },
        ..rule
    }
}

#[test]
fn accepts_every_alert_metric_default_rule() {
    for m in ALERT_METRICS {
        assert_eq!(default_rule(m).validate_custom(), Ok(()), "{}", m.metric);
    }
}

#[test]
fn accepts_one_series_of_a_labelled_metric() {
    let one_fan = with_series(fan(), "fan.rpm", Labels::single("fan", "1"));
    assert_eq!(one_fan.validate_custom(), Ok(()));
}

#[test]
fn rejects_an_empty_or_whitespace_name() {
    for name in ["", "   ", "\t\n"] {
        let rule = AlertRule {
            name: name.into(),
            ..memory()
        };
        assert_eq!(
            rule.validate_custom(),
            Err(AlertRuleError::Name),
            "{name:?}"
        );
    }
}

/// The limit counts characters, not bytes.
#[test]
fn rejects_a_name_over_60_characters() {
    let at_limit = AlertRule {
        name: "é".repeat(60),
        ..memory()
    };
    assert_eq!(at_limit.validate_custom(), Ok(()));
    let over = AlertRule {
        name: "x".repeat(61),
        ..memory()
    };
    assert_eq!(over.validate_custom(), Err(AlertRuleError::Name));
}

#[test]
fn rejects_a_metric_outside_the_list() {
    let rule = with_series(memory(), "cpu.user", Labels::new());
    assert_eq!(
        rule.validate_custom(),
        Err(AlertRuleError::Metric("cpu.user".into()))
    );
}

#[test]
fn rejects_a_label_key_the_metric_does_not_carry() {
    let wrong_key = with_series(fan(), "fan.rpm", Labels::single("vol", "/"));
    assert_eq!(wrong_key.validate_custom(), Err(AlertRuleError::Labels));
    let unlabelled_metric = with_series(memory(), "mem.pressure", Labels::single("core", "0"));
    assert_eq!(
        unlabelled_metric.validate_custom(),
        Err(AlertRuleError::Labels)
    );
}

#[test]
fn rejects_more_than_one_label_pair() {
    let two = Labels::from_pairs([("fan", "0"), ("zone", "a")]).unwrap();
    let rule = with_series(fan(), "fan.rpm", two);
    assert_eq!(rule.validate_custom(), Err(AlertRuleError::Labels));
}

#[test]
fn rejects_nan_and_infinite_values() {
    let range = Err(AlertRuleError::Value {
        min: 1.0,
        max: 100.0,
    });
    for v in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert_eq!(with_value(memory(), v).validate_custom(), range, "{v}");
    }
}

#[test]
fn rejects_a_value_below_min_or_above_max() {
    let range = Err(AlertRuleError::Value {
        min: 1.0,
        max: 100.0,
    });
    assert_eq!(with_value(memory(), 0.5).validate_custom(), range);
    assert_eq!(with_value(memory(), 100.5).validate_custom(), range);
    assert_eq!(with_value(memory(), 1.0).validate_custom(), Ok(()));
    assert_eq!(with_value(memory(), 100.0).validate_custom(), Ok(()));
}

#[test]
fn rejects_a_duration_over_an_hour() {
    let over = AlertRule {
        for_secs: 3601,
        ..memory()
    };
    assert_eq!(over.validate_custom(), Err(AlertRuleError::Duration));
    let at_limit = AlertRule {
        for_secs: 3600,
        ..memory()
    };
    assert_eq!(at_limit.validate_custom(), Ok(()));
}

#[test]
fn rejects_a_cooldown_outside_one_minute_to_a_day() {
    for cooldown_secs in [59, 86_401] {
        let rule = AlertRule {
            cooldown_secs,
            ..memory()
        };
        assert_eq!(
            rule.validate_custom(),
            Err(AlertRuleError::Cooldown),
            "{cooldown_secs}"
        );
    }
    for cooldown_secs in [60, 86_400] {
        let rule = AlertRule {
            cooldown_secs,
            ..memory()
        };
        assert_eq!(rule.validate_custom(), Ok(()), "{cooldown_secs}");
    }
}

#[test]
fn rejects_a_builtin_id() {
    for id in AlertRule::BUILTIN_IDS {
        let rule = AlertRule { id, ..memory() };
        assert_eq!(rule.validate_custom(), Err(AlertRuleError::ReservedId));
    }
}

#[test]
fn rejects_a_non_threshold_condition() {
    let rule = AlertRule {
        when: Condition::ThermalStateAtLeast(ThermalState::Fair),
        ..memory()
    };
    assert_eq!(rule.validate_custom(), Err(AlertRuleError::NotThreshold));
}

/// Errors state the limit they broke, as the Alerts page shows them.
#[test]
fn error_messages_state_the_limit() {
    assert_eq!(
        AlertRuleError::Cooldown.to_string(),
        "cooldown must be between 1 minute and 24 hours"
    );
    assert_eq!(
        AlertRuleError::Value {
            min: 1.0,
            max: 100.0
        }
        .to_string(),
        "threshold is outside the range this metric accepts"
    );
}

#[test]
fn series_name_numbers_fans_from_one_and_names_other_series_by_value() {
    assert_eq!(
        series_name("fan.rpm", &Labels::single("fan", "0")),
        Some("Fan 1".into())
    );
    assert_eq!(
        series_name("fan.rpm", &Labels::single("fan", "1")),
        Some("Fan 2".into())
    );
    assert_eq!(
        series_name("disk.free", &Labels::single("vol", "/")),
        Some("/".into())
    );
    assert_eq!(series_name("mem.pressure", &Labels::new()), None);
}
