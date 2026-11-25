use ciborium::Value;
use statglass_proto::{
    Answer, ErrorCode, HostAlertRules, Message, Query, RuleEntry, decode_message, encode_message,
};
use statglass_schema::usage::UsageKey;
use statglass_schema::{AlertRule, Cmp, Condition, Labels, MetricId, SeriesSelector};
use uuid::Uuid;

const REVISION: i64 = 1 << 45;
const REPLY_ID: u32 = 17;

fn disk_rule(id: u128, volume: &str) -> AlertRule {
    AlertRule {
        id: Uuid::from_u128(id),
        name: format!("Low disk space on {volume}"),
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: MetricId::from_static("disk.free"),
                labels: Labels::single("vol", volume),
            },
            op: Cmp::Lt,
            value: 20e9,
        },
        for_secs: 60,
        cooldown_secs: 600,
        enabled: true,
    }
}

fn reply(rules: Vec<RuleEntry>) -> Message {
    Message::Reply {
        id: REPLY_ID,
        answer: Answer::AlertRules(HostAlertRules {
            revision: REVISION,
            rules,
        }),
    }
}

fn map(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Map(
        fields
            .into_iter()
            .map(|(key, value)| (text(key), value))
            .collect(),
    )
}

fn text(value: &str) -> Value {
    Value::Text(value.into())
}

fn wire_message(kind: &str, id: u32, field: &'static str, value: Value) -> Value {
    map([
        ("t", text(kind)),
        ("c", map([("id", id.into()), (field, value)])),
    ])
}

fn cbor(value: &Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    ciborium::into_writer(value, &mut bytes)
        .unwrap_or_else(|e| panic!("could not encode test CBOR: {e}"));
    bytes
}

fn future_rule() -> Value {
    map([
        ("id", Value::Bytes(Uuid::from_u128(2).as_bytes().to_vec())),
        ("name", text("Disk space falling fast")),
        (
            "when",
            map([(
                "rate_of_change",
                map([
                    ("metric", text("disk.free")),
                    ("window_secs", Value::Integer(300.into())),
                ]),
            )]),
        ),
        ("for_secs", Value::Integer(60.into())),
        ("cooldown_secs", Value::Integer(600.into())),
        ("enabled", Value::Bool(true)),
    ])
}

fn tagged_future_rule() -> Value {
    let Value::Map(mut fields) = future_rule() else {
        panic!("future rule must be a CBOR map");
    };
    fields.push((
        text("introduced_at"),
        Value::Tag(0, Box::new(text("2026-11-24T00:00:00Z"))),
    ));
    Value::Map(fields)
}

#[test]
fn alert_rules_reply_round_trips_a_custom_threshold() {
    let rule = disk_rule(1, "/");
    rule.validate_custom().unwrap();
    let reply = reply(vec![RuleEntry::Known(rule)]);

    let body = encode_message(&reply).unwrap();
    assert_eq!(decode_message(&body).unwrap(), reply);
}

#[test]
fn alert_rules_reply_preserves_raw_cbor_for_an_unknown_condition() {
    let unknown = future_rule();
    let wire = wire_message(
        "Reply",
        REPLY_ID,
        "answer",
        map([
            ("a", text("AlertRules")),
            (
                "v",
                map([
                    ("revision", REVISION.into()),
                    ("rules", Value::Array(vec![unknown.clone()])),
                ]),
            ),
        ]),
    );
    let body = cbor(&wire);
    let decoded = decode_message(&body).unwrap();
    assert_eq!(decoded, reply(vec![RuleEntry::Unknown(unknown)]));
    assert_eq!(encode_message(&decoded).unwrap(), body);
}

#[test]
fn alert_rules_reply_keeps_known_rules_on_both_sides_of_an_unknown_one() {
    let reply = reply(vec![
        RuleEntry::Known(disk_rule(1, "/")),
        RuleEntry::Unknown(future_rule()),
        RuleEntry::Known(disk_rule(3, "/Volumes/Data")),
    ]);
    assert_eq!(
        decode_message(&encode_message(&reply).unwrap()).unwrap(),
        reply
    );
}

#[test]
fn alert_rules_reply_preserves_a_tagged_unknown_rule_between_known_rules() {
    let expected = reply(vec![
        RuleEntry::Known(disk_rule(1, "/")),
        RuleEntry::Unknown(tagged_future_rule()),
        RuleEntry::Known(disk_rule(3, "/Volumes/Data")),
    ]);
    let body = encode_message(&expected).unwrap();
    let decoded = decode_message(&body).unwrap();
    assert_eq!(decoded, expected);
    assert_eq!(encode_message(&decoded).unwrap(), body);
}

#[test]
fn alert_rules_read_request_round_trips() {
    let request = Message::Request {
        id: 19,
        query: Query::AlertRules,
    };
    assert_eq!(
        decode_message(&encode_message(&request).unwrap()).unwrap(),
        request
    );
}

#[test]
fn set_alert_rules_request_round_trips_entries_and_keep_ids() {
    let request = Message::Request {
        id: 18,
        query: Query::SetAlertRules {
            base_revision: REVISION,
            rules: vec![
                RuleEntry::Known(disk_rule(1, "/")),
                RuleEntry::Unknown(tagged_future_rule()),
            ],
            keep: vec![Uuid::from_u128(9), Uuid::from_u128(4)],
        },
    };
    assert_eq!(
        decode_message(&encode_message(&request).unwrap()).unwrap(),
        request
    );
}

fn fixture(name: &str, value: &Value) -> Vec<u8> {
    let built = cbor(value);
    // The existing forward_compat suite owns and counts fixtures in fixtures/skew.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/alert_rules");
    let path = dir.join(format!("{name}.cbor"));
    if std::env::var_os("STATGLASS_WRITE_FIXTURES").is_some() {
        std::fs::create_dir_all(&dir)
            .unwrap_or_else(|e| panic!("could not create {}: {e}", dir.display()));
        std::fs::write(&path, &built)
            .unwrap_or_else(|e| panic!("could not write {}: {e}", path.display()));
    }
    let bytes =
        std::fs::read(&path).unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
    assert_eq!(bytes, built, "fixture {name} differs from its builder");
    bytes
}

#[test]
fn a_future_query_with_content_keeps_its_request_id() {
    let body = fixture(
        "request_unknown_query",
        &wire_message(
            "Request",
            21,
            "query",
            map([
                ("q", text("PauseAlertRules")),
                ("a", map([("for_secs", 60.into())])),
            ]),
        ),
    );
    assert_eq!(
        decode_message(&body).unwrap(),
        Message::Request {
            id: 21,
            query: Query::Unknown
        }
    );
}

#[test]
fn a_future_reply_error_code_keeps_its_message() {
    let body = fixture(
        "reply_unknown_code",
        &wire_message(
            "Reply",
            21,
            "answer",
            map([
                ("a", text("Error")),
                (
                    "v",
                    map([
                        ("code", text("rules_paused")),
                        ("message", text("Rules are paused")),
                    ]),
                ),
            ]),
        ),
    );
    assert_eq!(
        decode_message(&body).unwrap(),
        Message::Reply {
            id: 21,
            answer: Answer::Error {
                code: ErrorCode::Unknown,
                message: "Rules are paused".into()
            },
        }
    );
}

#[test]
fn pre_alert_request_and_error_fixtures_keep_their_meaning() {
    assert_eq!(
        decode_message(include_bytes!("fixtures/v1/request_usage.cbor")).unwrap(),
        Message::Request {
            id: 7,
            query: Query::UsageByApp {
                from_ms: 1000,
                to_ms: 61_000,
                by: UsageKey::Memory,
                limit: 200
            },
        }
    );
    assert_eq!(
        decode_message(include_bytes!("fixtures/v1/reply_error.cbor")).unwrap(),
        Message::Reply {
            id: 8,
            answer: Answer::Error {
                code: ErrorCode::Unsupported,
                message: "not answered by this host".into()
            },
        }
    );
}

#[test]
fn stale_alert_rules_error_round_trips() {
    let reply = Message::Reply {
        id: 18,
        answer: Answer::Error {
            code: ErrorCode::Stale,
            message: "The rules changed".into(),
        },
    };
    assert_eq!(
        decode_message(&encode_message(&reply).unwrap()).unwrap(),
        reply
    );
}
