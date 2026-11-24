//! [`AlertSettings`]: the built-in switches, custom rules on the patch path
//! ([`AlertSettings::validate`]) and on the load path (lenient decode and
//! [`AlertSettings::drop_invalid`]).

use uuid::Uuid;

use super::*;
use crate::alert::{Cmp, Condition};
use crate::series::{Labels, MetricId, SeriesSelector};
use crate::settings::Settings;

fn rule(n: u128, value: f32) -> AlertRule {
    AlertRule {
        id: Uuid::from_u128(0x1000 + n),
        name: format!("Memory rule {n}"),
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: MetricId::from_static("mem.pressure"),
                labels: Labels::new(),
            },
            op: Cmp::Gt,
            value,
        },
        for_secs: 120,
        cooldown_secs: 1800,
        enabled: true,
    }
}

fn with_rules(rules: Vec<AlertRule>) -> AlertSettings {
    AlertSettings {
        rules,
        ..AlertSettings::default()
    }
}

#[test]
fn builtin_switches_enable_the_builtin_rules() {
    let a = AlertSettings {
        hot_process: true,
        ..AlertSettings::default()
    };
    let [hot, thermal] = a.builtin_rules();
    assert!(hot.enabled && !thermal.enabled);
    assert_eq!(hot.id, AlertRule::hot_process().id);
    assert_eq!(thermal.id, AlertRule::thermal_serious().id);
}

#[test]
fn validate_accepts_up_to_32_valid_rules() {
    let rules = (0..32).map(|n| rule(n, 80.0)).collect();
    assert_eq!(with_rules(rules).validate(), Ok(()));
}

#[test]
fn validate_rejects_33_rules_as_too_many() {
    let rules = (0..33).map(|n| rule(n, 80.0)).collect();
    assert_eq!(with_rules(rules).validate(), Err(AlertRuleError::TooMany));
}

#[test]
fn validate_rejects_two_rules_with_one_id() {
    let twin = AlertRule {
        name: "Memory twin".into(),
        ..rule(1, 90.0)
    };
    let a = with_rules(vec![rule(1, 80.0), twin]);
    assert_eq!(a.validate(), Err(AlertRuleError::DuplicateId));
}

#[test]
fn validate_rejects_a_rule_that_fails_validate_custom() {
    let a = with_rules(vec![rule(1, 80.0), rule(2, 250.0)]);
    assert_eq!(
        a.validate(),
        Err(AlertRuleError::Value {
            min: 1.0,
            max: 100.0
        })
    );
}

/// A settings file written before custom rules has neither `rules` nor `host_offline`:
/// both default and the two stored switches keep their values.
#[test]
fn settings_without_rules_or_host_offline_keep_the_builtin_switches() {
    let mut json = serde_json::to_value(Settings::default()).unwrap();
    json["alerts"] = serde_json::json!({ "hot_process": true, "thermal_serious": true });
    let s: Settings = serde_json::from_value(json).unwrap();
    assert_eq!(
        s.alerts,
        AlertSettings {
            hot_process: true,
            thermal_serious: true,
            host_offline: false,
            rules: vec![],
        }
    );
}

#[test]
fn engine_rules_list_builtins_first_then_custom_rules() {
    let off = AlertRule {
        enabled: false,
        ..rule(2, 90.0)
    };
    let a = AlertSettings {
        thermal_serious: true,
        rules: vec![rule(1, 80.0), off.clone()],
        ..AlertSettings::default()
    };
    let rules = a.engine_rules();
    let ids: Vec<(Uuid, bool)> = rules.iter().map(|r| (r.id, r.enabled)).collect();
    assert_eq!(
        ids,
        [
            (AlertRule::hot_process().id, false),
            (AlertRule::thermal_serious().id, true),
            (rule(1, 80.0).id, true),
            (off.id, false),
        ]
    );
    assert_eq!(rules[2], rule(1, 80.0));
}

/// Host offline is watched by the shell, so its switch never adds an engine rule.
#[test]
fn host_offline_is_never_an_engine_rule() {
    let a = AlertSettings {
        host_offline: true,
        ..AlertSettings::default()
    };
    let ids: Vec<Uuid> = a.engine_rules().iter().map(|r| r.id).collect();
    assert_eq!(
        ids,
        [AlertRule::hot_process().id, AlertRule::thermal_serious().id]
    );
}

/// The stored file holds one valid rule, one out of range and one with a condition
/// from a newer build. It decodes with every other setting intact; the newer entry is
/// skipped, and `drop_invalid` removes the out-of-range one and says why.
#[test]
fn load_path_keeps_valid_rules_and_drops_the_rest() {
    let mut stored = Settings::default();
    stored.sampling.interval_ms = 2000;
    stored.alerts.thermal_serious = true;
    let mut json = serde_json::to_value(&stored).unwrap();
    json["alerts"]["rules"] = serde_json::json!([
        serde_json::to_value(rule(1, 80.0)).unwrap(),
        serde_json::to_value(rule(2, 250.0)).unwrap(),
        {
            "id": Uuid::from_u128(0x1003),
            "name": "Battery health",
            "when": { "battery_health_below": 80 },
            "for_secs": 0,
            "cooldown_secs": 1800,
            "enabled": true
        }
    ]);
    let mut s: Settings = serde_json::from_value(json)
        .expect("a rule from a newer build is skipped, not a failed settings decode");
    assert_eq!(s.alerts.rules, [rule(1, 80.0), rule(2, 250.0)]);
    let dropped = s.alerts.drop_invalid();
    assert_eq!(
        dropped,
        [(
            rule(2, 250.0).id,
            AlertRuleError::Value {
                min: 1.0,
                max: 100.0
            }
        )]
    );
    assert_eq!(s.alerts.rules, [rule(1, 80.0)]);
    assert!(s.alerts.thermal_serious);
    assert_eq!(s.sampling.interval_ms, 2000);
    assert_eq!(s.alerts.validate(), Ok(()));
}

#[test]
fn drop_invalid_keeps_the_first_of_a_duplicate_id() {
    let twin = AlertRule {
        name: "Memory twin".into(),
        ..rule(1, 90.0)
    };
    let mut a = with_rules(vec![rule(1, 80.0), twin.clone()]);
    assert_eq!(a.drop_invalid(), [(twin.id, AlertRuleError::DuplicateId)]);
    assert_eq!(a.rules, [rule(1, 80.0)]);
}

#[test]
fn drop_invalid_drops_rules_past_the_limit() {
    let mut a = with_rules((0..34).map(|n| rule(n, 80.0)).collect());
    let dropped = a.drop_invalid();
    assert_eq!(
        dropped,
        [
            (rule(32, 80.0).id, AlertRuleError::TooMany),
            (rule(33, 80.0).id, AlertRuleError::TooMany),
        ]
    );
    assert_eq!(a.rules.len(), 32);
    assert_eq!(a.rules.last(), Some(&rule(31, 80.0)));
}
