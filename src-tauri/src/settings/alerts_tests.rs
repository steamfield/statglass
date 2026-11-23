//! Alert settings through the settings owner: the patch path (switches, the custom rule
//! list, validation), which rules a change switched on, and the load path.

use statglass_schema::settings::AlertSettings;
use statglass_schema::{
    AlertRule, AlertRuleError, Cmp, Condition, Labels, MetricId, SeriesSelector,
};
use uuid::Uuid;

use super::tests::{MemFile, Recorder};
use super::*;

fn rule(n: u128, value: f32) -> AlertRule {
    AlertRule {
        id: Uuid::from_u128(0x2000 + n),
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

fn with_alerts(alerts: AlertSettings) -> Settings {
    Settings {
        alerts,
        ..Settings::default()
    }
}

fn rules_patch(rules: Vec<AlertRule>) -> SettingsPatch {
    SettingsPatch {
        alerts: Some(AlertsPatch {
            rules: Some(rules),
            ..AlertsPatch::default()
        }),
        ..SettingsPatch::default()
    }
}

fn switched_on(old: &Settings, new: &Settings) -> Vec<Uuid> {
    alerts_switched_on(old, new)
        .rules
        .iter()
        .map(|r| r.id)
        .collect()
}

/// Switching an alert on reaches the engine (its rules are engine settings).
#[test]
fn alerts_patch_applies_and_affects_the_engine() {
    let patch: SettingsPatch =
        serde_json::from_str(r#"{"alerts":{"thermal_serious":true}}"#).unwrap();
    let old = Settings::default();
    let new = patch.apply(&old).unwrap();
    assert!(new.alerts.thermal_serious && !new.alerts.hot_process);
    assert!(engine_affecting(&old, &new));
}

/// Only rules going from off to on post the confirmation (and its permission prompt);
/// one staying on or going off does not.
#[test]
fn alerts_switched_on_lists_only_newly_enabled_rules() {
    let with = |hot_process, thermal_serious| {
        with_alerts(AlertSettings {
            hot_process,
            thermal_serious,
            ..AlertSettings::default()
        })
    };
    assert_eq!(
        switched_on(&with(false, false), &with(true, false)),
        [AlertRule::hot_process().id]
    );
    assert_eq!(
        switched_on(&with(true, false), &with(true, true)),
        [AlertRule::thermal_serious().id]
    );
    assert!(switched_on(&with(true, true), &with(true, false)).is_empty());
    assert!(switched_on(&with(true, true), &with(true, true)).is_empty());
    assert_eq!(switched_on(&with(false, false), &with(true, true)).len(), 2);
}

/// Turning host offline on is reported (it is no engine rule); keeping it on or
/// turning it off is not.
#[test]
fn turning_host_offline_on_is_switched_on() {
    let with = |host_offline| {
        with_alerts(AlertSettings {
            host_offline,
            ..AlertSettings::default()
        })
    };
    let on = alerts_switched_on(&with(false), &with(true));
    assert_eq!(
        on,
        SwitchedOn {
            rules: vec![],
            host_offline: true,
        }
    );
    assert!(!on.is_empty());
    assert!(alerts_switched_on(&with(true), &with(true)).is_empty());
    assert!(alerts_switched_on(&with(true), &with(false)).is_empty());
}

#[test]
fn a_rules_patch_replaces_the_list_and_keeps_the_switches() {
    let base = with_alerts(AlertSettings {
        thermal_serious: true,
        rules: vec![rule(1, 80.0), rule(2, 90.0)],
        ..AlertSettings::default()
    });
    let new = rules_patch(vec![rule(3, 70.0)]).apply(&base).unwrap();
    assert_eq!(
        new.alerts,
        AlertSettings {
            thermal_serious: true,
            rules: vec![rule(3, 70.0)],
            ..AlertSettings::default()
        }
    );
}

#[test]
fn the_host_offline_switch_is_patched() {
    let patch: SettingsPatch = serde_json::from_str(r#"{"alerts":{"host_offline":true}}"#).unwrap();
    let new = patch.apply(&Settings::default()).unwrap();
    assert!(new.alerts.host_offline);
}

/// A rule Rust refuses fails the update with the reason and saves nothing.
#[test]
fn an_invalid_rule_fails_the_update_and_saves_nothing() {
    let file = MemFile::default();
    let owner = SettingsOwner::load(Box::new(file.clone()));
    let before = owner.get();
    let effects = Recorder::default();
    let bad = AlertRule {
        cooldown_secs: 30,
        ..rule(1, 80.0)
    };
    let result = owner.update(&rules_patch(vec![bad]), &effects);
    assert_eq!(
        result,
        Err(CommandError::InvalidSettings {
            message: AlertRuleError::Cooldown.to_string(),
        })
    );
    assert_eq!(*file.saves.lock().unwrap(), 0);
    assert!(effects.calls.borrow().is_empty());
    assert_eq!(owner.get(), before);
}

#[test]
fn a_valid_rules_patch_is_saved() {
    let file = MemFile::default();
    let owner = SettingsOwner::load(Box::new(file.clone()));
    let now = owner
        .update(&rules_patch(vec![rule(1, 80.0)]), &Recorder::default())
        .unwrap();
    assert_eq!(now.settings.alerts.rules, [rule(1, 80.0)]);
    assert_eq!(*file.saves.lock().unwrap(), 1);
}

#[test]
fn adding_an_enabled_rule_or_switching_one_on_is_switched_on() {
    let none = with_alerts(AlertSettings::default());
    let on = with_alerts(AlertSettings {
        rules: vec![rule(1, 80.0)],
        ..AlertSettings::default()
    });
    let off = with_alerts(AlertSettings {
        rules: vec![AlertRule {
            enabled: false,
            ..rule(1, 80.0)
        }],
        ..AlertSettings::default()
    });
    assert_eq!(switched_on(&none, &on), [rule(1, 80.0).id]);
    assert_eq!(switched_on(&off, &on), [rule(1, 80.0).id]);
    assert!(switched_on(&on, &off).is_empty());
    let added_off = with_alerts(AlertSettings {
        rules: vec![
            rule(1, 80.0),
            AlertRule {
                enabled: false,
                ..rule(2, 90.0)
            },
        ],
        ..AlertSettings::default()
    });
    assert!(switched_on(&on, &added_off).is_empty());
}

#[test]
fn editing_a_rule_that_stays_enabled_is_not_switched_on() {
    let before = with_alerts(AlertSettings {
        rules: vec![rule(1, 80.0)],
        ..AlertSettings::default()
    });
    let after = with_alerts(AlertSettings {
        rules: vec![AlertRule {
            name: "Memory is tight".into(),
            ..rule(1, 85.0)
        }],
        ..AlertSettings::default()
    });
    assert!(switched_on(&before, &after).is_empty());
}

#[test]
fn a_rules_change_affects_the_engine() {
    let old = Settings::default();
    let new = rules_patch(vec![rule(1, 80.0)]).apply(&old).unwrap();
    assert!(engine_affecting(&old, &new));
}

/// The stored file holds one valid rule, one out of range and one with a condition
/// from a newer build. The owner loads it with every other setting intact and only the
/// valid rule; it does not fall back to defaults.
#[test]
fn a_bad_stored_rule_is_dropped_without_resetting_the_settings() {
    let mut stored = Settings::default();
    stored.sampling.interval_ms = 2000;
    stored.alerts.hot_process = true;
    let mut json = serde_json::to_value(&stored).unwrap();
    json["alerts"]["rules"] = serde_json::json!([
        serde_json::to_value(rule(1, 80.0)).unwrap(),
        serde_json::to_value(rule(2, 250.0)).unwrap(),
        {
            "id": Uuid::from_u128(0x2003),
            "name": "Battery health",
            "when": { "battery_health_below": 80 },
            "for_secs": 0,
            "cooldown_secs": 1800,
            "enabled": true
        }
    ]);
    let file = MemFile::default();
    *file.value.lock().unwrap() = Some(json);
    let owner = SettingsOwner::load_with_defaults(Box::new(file), Settings::default());
    assert!(!owner.first_run());
    let expected = Settings {
        alerts: AlertSettings {
            hot_process: true,
            rules: vec![rule(1, 80.0)],
            ..AlertSettings::default()
        },
        ..stored
    };
    assert_eq!(owner.settings(), expected);
}

/// The loader counts stored rules from the raw value, so it can say how many the
/// lenient decode skipped.
#[test]
fn stored_rule_count_reads_the_raw_list() {
    use crate::settings::stored_rule_count;
    let stored = serde_json::json!({ "alerts": { "rules": [{}, { "id": 7 }, null] } });
    assert_eq!(stored_rule_count(&stored), 3);
    assert_eq!(stored_rule_count(&serde_json::json!({ "alerts": {} })), 0);
    assert_eq!(
        stored_rule_count(&serde_json::json!({ "alerts": { "rules": null } })),
        0
    );
    assert_eq!(stored_rule_count(&serde_json::json!({})), 0);
}
