use super::*;
use crate::alerts::commands::{RemoteAlertRules, replace_alert_rules};
use statglass_proto::{Answer, HostAlertRules, Message, RuleEntry, decode_message};
use statglass_remote::RemoteError;
use statglass_schema::{AlertRule, Cmp, Condition, Labels, MetricId, SeriesSelector};

fn rule(id: u128, name: &str) -> AlertRule {
    AlertRule {
        id: Uuid::from_u128(id),
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
        cooldown_secs: 600,
        enabled: true,
    }
}

#[test]
fn remote_alert_rules_keep_known_order_and_expose_only_newer_ids() {
    let first = rule(1, "First rule");
    let second = rule(2, "Second rule");
    let byte_id = Uuid::from_u128(3);
    let text_id = Uuid::from_u128(4);
    let revision = (1 << 53) - 1;
    let rules = RemoteAlertRules::from(HostAlertRules {
        revision,
        rules: vec![
            RuleEntry::Known(first.clone()),
            RuleEntry::Unknown(vec![("id".into(), byte_id.as_bytes().as_slice().into())].into()),
            RuleEntry::Unknown(vec![("id".into(), "invalid UUID".into())].into()),
            RuleEntry::Known(second.clone()),
            RuleEntry::Unknown(vec![("other".into(), text_id.to_string().into())].into()),
            RuleEntry::Unknown(vec![("id".into(), text_id.to_string().into())].into()),
            RuleEntry::Unknown(42.into()),
        ],
    });
    assert_eq!(
        serde_json::to_value(rules).unwrap(),
        serde_json::json!({
            "revision": revision,
            "rules": [first, second],
            "newer": [{"id": byte_id}, {"id": null}, {"id": null}, {"id": text_id}, {"id": null}],
        }),
    );
}

#[test]
fn remote_alert_rules_expose_a_cbor_tagged_uuid() {
    let id = Uuid::from_u128(5);
    // A reply with one undecodable rule, whose byte-string id carries CBOR tag 37 (UUID).
    let mut body = b"\xa2\x61t\x65Reply\x61c\xa2\x62id\x01\x66answer\
        \xa2\x61a\x6aAlertRules\x61v\xa2\x68revision\x01\x65rules\x81\xa1\
        \x62id\xd8\x25\x50"
        .to_vec();
    body.extend_from_slice(id.as_bytes());
    let Message::Reply {
        answer: Answer::AlertRules(rules),
        ..
    } = decode_message(&body).unwrap()
    else {
        panic!("expected alert rules");
    };
    assert_eq!(
        serde_json::to_value(RemoteAlertRules::from(rules)).unwrap(),
        serde_json::json!({"revision": 1, "rules": [], "newer": [{"id": id}]}),
    );
}

#[tokio::test]
async fn remote_alert_rules_replace_sends_the_revision_rules_and_keep_ids() {
    let edited = rule(1, "Edited rule");
    let keep = Uuid::from_u128(2);
    let revision = 1_i64 << 45;
    let base_revision = serde_json::from_value(serde_json::json!(revision)).unwrap();
    let view = replace_alert_rules(
        base_revision,
        vec![edited.clone()],
        vec![keep],
        async |sent_revision, sent_rules, sent_keep| {
            assert_eq!(sent_revision, revision);
            assert_eq!(sent_rules, [RuleEntry::Known(edited.clone())]);
            assert_eq!(sent_keep, [keep]);
            Ok(HostAlertRules {
                revision: revision + 1,
                rules: vec![
                    RuleEntry::Known(edited.clone()),
                    RuleEntry::Unknown(
                        vec![("id".into(), keep.as_bytes().as_slice().into())].into(),
                    ),
                ],
            })
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(view).unwrap(),
        serde_json::json!({"revision": revision + 1, "rules": [edited], "newer": [{"id": keep}]}),
    );
}

#[test]
fn remote_alert_rules_refusals_keep_the_host_message_and_actionable_kind() {
    for (remote, kind, message) in [
        (
            RemoteError::Stale("rules changed".into()),
            "remote_rules_changed",
            "rules changed",
        ),
        (
            RemoteError::Unsupported("update the agent".into()),
            "remote_unsupported",
            "update the agent",
        ),
        (
            RemoteError::InvalidArgument("invalid rule".into()),
            "invalid_settings",
            "invalid rule",
        ),
        (
            RemoteError::Refused("saving failed".into()),
            "internal",
            "saving failed",
        ),
        (
            RemoteError::Transport("the host is not connected".into()),
            "remote_unreachable",
            "the host is not connected",
        ),
        (
            RemoteError::Busy("the host did not answer in time".into()),
            "remote_busy",
            "the host did not answer in time",
        ),
    ] {
        assert_eq!(
            serde_json::to_value(CommandError::from_alert_rules(remote)).unwrap(),
            serde_json::json!({"kind": kind, "message": message}),
        );
    }
}

#[tokio::test]
async fn remote_alert_rules_refuse_this_mac_and_a_saved_mac_before_querying() {
    let remotes = RemoteManager::default();
    let local = crate::test_support::mac_host(1).id;
    let mut mac = crate::test_support::mac_host(2);
    mac.is_local = false;
    let mut linux = crate::test_support::bare_host(3, "Linux", statglass_schema::OsKind::Linux);
    linux.is_local = false;
    let linux_command = RemoteCommand::Agent {
        bin: "/usr/bin/statglass-agent".into(),
        system: false,
        socket: None,
    };
    for (record, command) in [
        (mac.clone(), RemoteCommand::default()),
        (linux.clone(), linux_command),
    ] {
        let host = record.id;
        let saved = SavedHost {
            config: RemoteHostConfig {
                id: host.to_string(),
                name: record.display_name.clone(),
                lan: Some("fixture".into()),
                tailscale: None,
                enabled: true,
                mirror_budget_mb: 100,
            },
            record: record.clone(),
            command,
            last_agent_version: None,
        };
        let source = RemoteSource::new(record, local, saved.endpoint(), Arc::new(|_| {}), None);
        remotes.sources.lock_ok().insert(host, source);
        remotes.saved.lock_ok().insert(host, saved);
    }

    let refusal = CommandError::InvalidArgument {
        message: "Alert rules on this host are set on that Mac".into(),
    };
    for host in [local, mac.id] {
        assert_eq!(
            remotes.alert_rules_source(local, host).err(),
            Some(refusal.clone())
        );
    }
    assert!(matches!(
        remotes
            .alert_rules_source(local, linux.id)
            .unwrap()
            .alert_rules()
            .await,
        Err(RemoteError::Transport(_))
    ));
    let unknown = HostId(Uuid::from_u128(4));
    assert_eq!(
        remotes.alert_rules_source(local, unknown).err(),
        Some(CommandError::UnknownHost { host: unknown })
    );
}
