use super::*;
use crate::settings::{self, SETTINGS_FILE};
use serde_json::Value;
use statglass_schema::{Cmp, Condition, Labels, MetricId, SeriesSelector};

fn cpu_rule(id: u128) -> AlertRule {
    AlertRule {
        id: Uuid::from_u128(id),
        name: "High CPU".into(),
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: MetricId::from_static("cpu.total"),
                labels: Labels::default(),
            },
            op: Cmp::Gt,
            value: 80.0,
        },
        for_secs: 2,
        cooldown_secs: 60,
        enabled: true,
    }
}

fn disk_condition(labels: Labels) -> Condition {
    Condition::Threshold {
        series: SeriesSelector {
            metric: MetricId::from_static("disk.free"),
            labels,
        },
        op: Cmp::Lt,
        value: 1e9,
    }
}

fn invalid_rule() -> AlertRule {
    let mut rule = cpu_rule(3);
    if let Condition::Threshold { value, .. } = &mut rule.when {
        *value = 101.0;
    }
    rule
}

fn snapshot(rules: &[AlertRule]) -> HostAlertRules {
    HostAlertRules {
        revision: rules_revision(rules),
        rules: rules.iter().cloned().map(RuleEntry::Known).collect(),
    }
}

fn saved(answer: Answer) -> HostAlertRules {
    match answer {
        Answer::AlertRules(rules) => rules,
        other => panic!("expected alert rules, got {other:?}"),
    }
}

fn refusal(answer: Answer, expected: ErrorCode) -> String {
    match answer {
        Answer::Error { code, message } => {
            assert_eq!(code, expected);
            message
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

#[test]
fn revision_is_stable_sensitive_to_fields_and_order_and_safe_for_js() {
    let rule = cpu_rule(1);
    let other = AlertRule {
        when: disk_condition(Labels::default()),
        ..cpu_rule(2)
    };
    assert_eq!(
        rules_revision(std::slice::from_ref(&rule)),
        2_599_911_580_475_547
    );

    let rules = [rule.clone(), other.clone()];
    let revision = rules_revision(&rules);
    assert!((0..(1 << 53)).contains(&revision));
    assert_eq!(revision, rules_revision(&rules.clone()));
    assert_ne!(revision, rules_revision(&[other.clone(), rule.clone()]));
    for edit in [
        AlertRule {
            id: Uuid::from_u128(4),
            ..rule.clone()
        },
        AlertRule {
            name: "CPU spike".into(),
            ..rule.clone()
        },
        AlertRule {
            when: other.when.clone(),
            ..rule.clone()
        },
        AlertRule {
            for_secs: 3,
            ..rule.clone()
        },
        AlertRule {
            cooldown_secs: 61,
            ..rule.clone()
        },
        AlertRule {
            enabled: false,
            ..rule.clone()
        },
    ] {
        assert_ne!(revision, rules_revision(&[edit, other.clone()]));
    }
    let Condition::Threshold { series, op, value } = &rule.when else {
        unreachable!()
    };
    for when in [
        Condition::Threshold {
            series: series.clone(),
            op: Cmp::Ge,
            value: *value,
        },
        Condition::Threshold {
            series: series.clone(),
            op: *op,
            value: 81.0,
        },
    ] {
        let edit = AlertRule {
            when,
            ..rule.clone()
        };
        assert_ne!(revision, rules_revision(&[edit, other.clone()]));
    }
    let labeled = AlertRule {
        when: disk_condition(serde_json::from_value(json!([["vol", "/"]])).unwrap()),
        ..other
    };
    assert_ne!(revision, rules_revision(&[rule, labeled]));
}

#[test]
fn current_reports_loaded_rules() {
    let dir = tempfile::tempdir().unwrap();
    let rule = cpu_rule(1);
    settings::configure(
        dir.path(),
        &json!({"alerts": {"rules": [rule]}}).to_string(),
    )
    .unwrap();
    let store = AlertRuleStore::new(dir.path().into(), settings::load(dir.path()));
    assert_eq!(store.current(), snapshot(&[rule]));
}

#[test]
fn saves_only_rules_and_applies_only_the_live_rule_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SETTINGS_FILE);
    let first = cpu_rule(1);
    settings::configure(
        dir.path(),
        &json!({"alerts": {"rules": [first]}}).to_string(),
    )
    .unwrap();
    let active = settings::load(dir.path());
    let store = AlertRuleStore::new(dir.path().into(), active.clone());

    // A concurrent operator's CLI preferences are in the file, pending restart.
    settings::configure(
        dir.path(),
        r#"{"history":{"retention_days":7},"alerts":{"host_offline":true}}"#,
    )
    .unwrap();
    let mut expected_file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let next = cpu_rule(2);
    expected_file["alerts"]["rules"] = json!([next]);
    let mut expected_settings = active;
    expected_settings.alerts.rules = vec![next.clone()];
    let mut applied = Vec::new();

    let answer = store.replace(
        rules_revision(&[first]),
        vec![RuleEntry::Known(next.clone())],
        vec![],
        |settings| applied.push(settings.clone()),
    );
    let actual_file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(actual_file, expected_file);
    assert_eq!(applied, [expected_settings]);
    assert_eq!(saved(answer), snapshot(&[next]));
    assert_eq!(
        store.current(),
        snapshot(&settings::load(dir.path()).alerts.rules)
    );
}

#[test]
fn refusals_leave_the_file_and_active_rules_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SETTINGS_FILE);
    let first = cpu_rule(1);
    let replacement = cpu_rule(2);
    settings::configure(
        dir.path(),
        &json!({"alerts": {"rules": [first]}}).to_string(),
    )
    .unwrap();
    let store = AlertRuleStore::new(dir.path().into(), settings::load(dir.path()));
    let current = snapshot(&[first]);
    let file = std::fs::read(&path).unwrap();
    let unknown: RuleEntry = serde_json::from_value(json!({"when": "future_condition"})).unwrap();
    assert!(matches!(unknown, RuleEntry::Unknown(_)));
    let invalid = invalid_rule();
    let validation_error = invalid.validate_custom().unwrap_err().to_string();
    for (revision, rule, code, message) in [
        (
            current.revision ^ 1,
            RuleEntry::Known(replacement.clone()),
            ErrorCode::Stale,
            "The alert rules on this host changed. Reload them and try again.",
        ),
        (
            current.revision,
            unknown,
            ErrorCode::InvalidArgument,
            "This agent does not know one of these rules. Update the agent.",
        ),
        (
            current.revision,
            RuleEntry::Known(invalid),
            ErrorCode::InvalidArgument,
            &validation_error,
        ),
    ] {
        let answer = store.replace(revision, vec![rule], vec![], |_| {
            panic!("refused rules applied")
        });
        assert_eq!(refusal(answer, code), message);
        assert_eq!(std::fs::read(&path).unwrap(), file);
        assert_eq!(store.current(), current);
    }

    // Occupy the atomic staging path so the write fails even when tests run as root.
    std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
    let answer = store.replace(
        current.revision,
        vec![RuleEntry::Known(replacement)],
        vec![],
        |_| {
            panic!("unsaved rules applied");
        },
    );
    let message = refusal(answer, ErrorCode::Internal);
    assert!(
        message.starts_with("Saving the alert rules: writing "),
        "{message}"
    );
    assert!(message.contains("settings.json.tmp"), "{message}");
    assert_eq!(std::fs::read(&path).unwrap(), file);
    assert_eq!(store.current(), current);
}

#[test]
fn keeps_existing_ids_in_their_current_order_after_sent_rules() {
    let dir = tempfile::tempdir().unwrap();
    let first = cpu_rule(1);
    let omitted = cpu_rule(2);
    let last = cpu_rule(3);
    let next = cpu_rule(4);
    let mut settings = Settings::agent_default();
    settings.alerts.rules = vec![first.clone(), omitted, last.clone()];
    let base = rules_revision(&settings.alerts.rules);
    let store = AlertRuleStore::new(dir.path().into(), settings);
    let answer = store.replace(
        base,
        vec![RuleEntry::Known(next.clone())],
        vec![last.id, Uuid::nil(), first.id],
        |_| {},
    );
    let expected = [next, first, last];
    assert_eq!(saved(answer), snapshot(&expected));
    assert_eq!(settings::load(dir.path()).alerts.rules, expected);
}

#[test]
fn only_one_concurrent_writer_can_change_a_revision() {
    let dir = tempfile::tempdir().unwrap();
    let base = rules_revision(&[]);
    let store = AlertRuleStore::new(dir.path().into(), Settings::agent_default());
    let barrier = std::sync::Barrier::new(2);
    let applied = Mutex::new(Vec::new());
    let replace = |id| {
        barrier.wait();
        store.replace(
            base,
            vec![RuleEntry::Known(cpu_rule(id))],
            vec![],
            |settings| {
                applied.lock_ok().push(snapshot(&settings.alerts.rules));
            },
        )
    };
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| replace(1));
        let b = scope.spawn(|| replace(2));
        (a.join().unwrap(), b.join().unwrap())
    });
    let (winner, loser) = if matches!(a, Answer::AlertRules(_)) {
        (a, b)
    } else {
        (b, a)
    };
    let winner = saved(winner);
    refusal(loser, ErrorCode::Stale);
    assert_eq!(store.current(), winner);
    assert_eq!(snapshot(&settings::load(dir.path()).alerts.rules), winner);
    assert_eq!(*applied.lock_ok(), [winner]);
}

#[test]
fn load_drops_invalid_rules_and_keeps_other_settings() {
    let dir = tempfile::tempdir().unwrap();
    let first = cpu_rule(1);
    let last = cpu_rule(2);
    let overlay = json!({"alerts": {"rules": [first, invalid_rule(), last]}, "history": {"retention_days": 7}});
    std::fs::write(dir.path().join(SETTINGS_FILE), overlay.to_string()).unwrap();
    let mut expected = Settings::agent_default();
    expected.alerts.rules = vec![first, last];
    expected.history.retention_days = 7;
    assert_eq!(settings::load(dir.path()), expected);
}

#[test]
fn load_warns_when_a_saved_rule_cannot_decode() {
    let dir = tempfile::tempdir().unwrap();
    let valid = cpu_rule(1);
    let mut unsupported = json!(cpu_rule(2));
    unsupported["when"] = json!({"future_condition": {}});
    let decode_error = serde_json::from_value::<AlertRule>(unsupported.clone())
        .unwrap_err()
        .to_string();
    let overlay = json!({"alerts": {"rules": [valid, unsupported]}});
    std::fs::write(dir.path().join(SETTINGS_FILE), overlay.to_string()).unwrap();

    let log_path = dir.path().join("warnings.log");
    let writer = std::fs::File::create(&log_path).unwrap();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.try_clone().unwrap())
        .finish();
    let loaded = tracing::subscriber::with_default(subscriber, || settings::load(dir.path()));

    assert_eq!(loaded.alerts.rules, [valid]);
    let log = std::fs::read_to_string(log_path).unwrap();
    assert!(log.contains("dropping undecodable alert rule"), "{log}");
    assert!(log.contains(&cpu_rule(2).id.to_string()), "{log}");
    assert!(log.contains(&decode_error), "{log}");
}
