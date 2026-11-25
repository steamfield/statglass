use super::*;
use crate::remote::alert_rules_test_source;
use serde_json::{Value, json};
use statglass_proto::{Answer, ErrorCode, Message, Query, decode_message, encode_frame};
use statglass_remote::{RemoteCommand, RemoteSource};
use statglass_schema::{AlertRule, Cmp, Condition, Labels, MetricId, SeriesSelector};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

fn linux() -> (RemoteManager, HostId, HostId, Arc<RemoteSource>) {
    let remotes = RemoteManager::default();
    let local = crate::test_support::mac_host(1).id;
    let record = crate::test_support::bare_host(2, "Linux", statglass_schema::OsKind::Linux);
    let host = record.id;
    let source = alert_rules_test_source(
        &remotes,
        local,
        record,
        RemoteCommand::Agent {
            bin: "/usr/bin/statglass-agent".into(),
            system: false,
            socket: None,
        },
    );
    (remotes, local, host, source)
}

async fn request(peer: &mut DuplexStream, expected: Query) -> u32 {
    tokio::time::timeout(Duration::from_secs(1), async {
        let len = usize::try_from(peer.read_u32().await.unwrap()).unwrap();
        let mut body = vec![0; len];
        peer.read_exact(&mut body).await.unwrap();
        let Message::Request { id, query } = decode_message(&body).unwrap() else {
            panic!("expected a query request");
        };
        assert_eq!(query, expected);
        id
    })
    .await
    .unwrap()
}

async fn answer(peer: &mut DuplexStream, query: Query, answer: Answer) {
    let id = request(peer, query).await;
    peer.write_all(&encode_frame(&Message::Reply { id, answer }).unwrap())
        .await
        .unwrap();
}

fn error_json(result: Result<RemoteAlertRules, CommandError>) -> Value {
    serde_json::to_value(result.err().expect("expected command failure")).unwrap()
}

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

#[tokio::test(start_paused = true)]
async fn remote_alert_rules_commands_read_and_replace_over_the_wire() {
    let (remotes, local, host, source) = linux();
    let (mut peer, driver) = source.test_query_peer(true);
    let Message::Reply {
        answer: Answer::AlertRules(future),
        ..
    } = decode_message(include_bytes!(
        "../../../crates/statglass-proto/tests/fixtures/alert_rules/reply_rule_extra_field.cbor"
    ))
    .unwrap()
    else {
        panic!("expected alert rules");
    };
    let revision = future.revision;
    let original = rule(1, "Original rule");
    let edited = rule(1, "Edited rule");
    let keep = Uuid::from_u128(2);
    let original_entry = RuleEntry::Known(original.clone());
    let edited_entry = RuleEntry::Known(edited.clone());
    let ((), (), closed) = tokio::join!(
        async {
            let view = read_alert_rules(&remotes, local, host).await.unwrap();
            let result = serde_json::to_value(&view).unwrap();
            assert_eq!(
                result,
                json!({"revision": revision, "rules": [original], "newer": [{"id": keep}]})
            );
            let base_revision = serde_json::from_value(result["revision"].clone()).unwrap();
            let keep_ids = view
                .newer
                .into_iter()
                .filter_map(|entry| entry.id)
                .collect();
            let result = write_alert_rules(
                &remotes,
                local,
                host,
                base_revision,
                vec![edited.clone()],
                keep_ids,
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                json!({"revision": revision + 1, "rules": [edited], "newer": [{"id": keep}]})
            );
        },
        async move {
            let mut first = future.clone();
            first.rules.insert(0, original_entry);
            answer(&mut peer, Query::AlertRules, Answer::AlertRules(first)).await;

            let mut next = future;
            next.revision += 1;
            next.rules.insert(0, edited_entry.clone());
            answer(
                &mut peer,
                Query::SetAlertRules {
                    base_revision: revision,
                    rules: vec![edited_entry],
                    keep: vec![keep],
                },
                Answer::AlertRules(next),
            )
            .await;
        },
        driver,
    );
    closed.unwrap();
}

#[tokio::test(start_paused = true)]
async fn remote_alert_rules_commands_preserve_host_refusal_messages_and_kinds() {
    let (remotes, local, host, source) = linux();
    for (code, kind, message) in [
        (ErrorCode::Stale, "remote_rules_changed", "rules changed"),
        (
            ErrorCode::Unsupported,
            "remote_unsupported",
            "update the agent",
        ),
        (
            ErrorCode::InvalidArgument,
            "invalid_settings",
            "invalid rule",
        ),
        (ErrorCode::Internal, "internal", "saving failed"),
    ] {
        let (mut peer, driver) = source.test_query_peer(true);
        let read = code == ErrorCode::Unsupported;
        let query = if read {
            Query::AlertRules
        } else {
            Query::SetAlertRules {
                base_revision: 7,
                rules: vec![],
                keep: vec![],
            }
        };
        let (result, (), closed) = tokio::join!(
            async {
                if read {
                    read_alert_rules(&remotes, local, host).await
                } else {
                    write_alert_rules(&remotes, local, host, RulesRevision(7), vec![], vec![]).await
                }
            },
            async move {
                answer(
                    &mut peer,
                    query,
                    Answer::Error {
                        code,
                        message: message.into(),
                    },
                )
                .await
            },
            driver,
        );
        closed.unwrap();
        assert_eq!(
            error_json(result),
            json!({"kind": kind, "message": message})
        );
    }
}

#[tokio::test(start_paused = true)]
async fn remote_alert_rules_commands_report_offline_and_query_timeout() {
    let (remotes, local, host, source) = linux();
    assert_eq!(
        error_json(read_alert_rules(&remotes, local, host).await),
        json!({
            "kind": "remote_unreachable", "message": "the host is not connected"
        })
    );

    let (mut peer, driver) = source.test_query_peer(true);
    let commands = &remotes;
    let ((result, ()), closed) = tokio::join!(
        async move {
            tokio::join!(read_alert_rules(commands, local, host), async {
                request(&mut peer, Query::AlertRules).await;
                tokio::time::advance(Duration::from_secs(16)).await;
            })
        },
        driver
    );
    closed.unwrap();
    assert_eq!(
        error_json(result),
        json!({"kind": "remote_busy", "message": "the host did not answer in time"}),
    );
}

#[tokio::test(start_paused = true)]
async fn remote_alert_rules_commands_report_a_session_without_queries() {
    let (remotes, local, host, source) = linux();
    let (mut peer, driver) = source.test_query_peer(false);
    let ((), closed) = tokio::join!(
        async move {
            let read = read_alert_rules(&remotes, local, host).await;
            let write =
                write_alert_rules(&remotes, local, host, RulesRevision(7), vec![], vec![]).await;
            let expected = json!({"kind": "remote_incompatible", "message": "incompatible remote: this host's StatGlass is too old to answer; update it"});
            assert_eq!(error_json(read), expected);
            assert_eq!(error_json(write), expected);
            assert!(
                tokio::time::timeout(Duration::from_millis(1), peer.read_u8())
                    .await
                    .is_err()
            );
        },
        driver
    );
    closed.unwrap();
}
