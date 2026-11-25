use ciborium::Value;
use serde::Deserialize;
use statglass_proto::{
    Answer, ErrorCode, HISTORY_QUERY_FEATURE, HistoryAnswer, HistoryClamp, HistoryQuery, Message,
    Offer, Query, WireEvent, WireHistorySeries, WireSeriesStats, decode_message, encode_message,
    local_features, negotiate,
};
use statglass_schema::{Module, SeriesKey, SeriesSelector, Tier, usage::UsageKey};

fn history_answer(key: SeriesKey) -> HistoryAnswer {
    HistoryAnswer {
        tier: Tier::S10,
        bucket_ms: 10_000,
        complete_to_ms: 30_000,
        series: vec![WireHistorySeries {
            key: key.clone(),
            points: vec![(10_000, 24.0, 20.0, 30.0)],
            hold_ms: 10_000,
        }],
        gaps: Vec::new(),
        events: vec![WireEvent {
            source_id: Some(7),
            seq: 42,
            ts_ms: 10_000,
            kind: "future_event".into(),
            payload: vec![0xa0],
        }],
        stats: vec![WireSeriesStats {
            key,
            avg: Some(24.0),
            peak: Some(30.0),
            measured_ms: Some(20_000),
            integral: Some(480.0),
        }],
        clamped: vec![HistoryClamp::Points],
    }
}

fn history_request(id: u32, key: &SeriesKey) -> Message {
    Message::Request {
        id,
        query: Query::History(HistoryQuery {
            series: vec![SeriesSelector {
                metric: key.metric.clone(),
                labels: key.labels.clone(),
            }],
            from_ms: 10_000,
            to_ms: None,
            max_points: 50,
            events_for: Some(Module::Cpu),
        }),
    }
}

#[test]
fn history_request_and_reply_with_a_future_event_round_trip() {
    let key = SeriesKey::parse("cpu.total").unwrap();
    for message in [
        history_request(1, &key),
        Message::Reply {
            id: 1,
            answer: Answer::History(history_answer(key)),
        },
    ] {
        assert_eq!(
            decode_message(&encode_message(&message).unwrap()).unwrap(),
            message
        );
    }
}

#[test]
fn history_is_opt_in_and_an_older_decoder_treats_its_request_as_unknown() {
    #[derive(Deserialize)]
    #[serde(tag = "t", content = "c")]
    enum LegacyMessage {
        Request { id: u32, query: Value },
    }

    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(tag = "q", content = "a")]
    enum LegacyQuery {
        UsageByApp {
            from_ms: i64,
            to_ms: i64,
            by: UsageKey,
            limit: u32,
        },
        #[serde(other)]
        Unknown,
    }

    let current = Offer::local(local_features());
    assert!(current.features.contains("query.history.v1"));
    let mut older = current.clone();
    older.features.remove(HISTORY_QUERY_FEATURE);
    for (a, b) in [(&current, &older), (&older, &current)] {
        assert!(
            !negotiate(a, b)
                .unwrap()
                .features
                .contains(HISTORY_QUERY_FEATURE)
        );
    }

    let bytes = encode_message(&history_request(
        27,
        &SeriesKey::parse("cpu.total").unwrap(),
    ))
    .unwrap();
    let LegacyMessage::Request { id, query } = ciborium::from_reader(bytes.as_slice()).unwrap();
    assert_eq!(id, 27);
    assert_eq!(
        query.deserialized().unwrap_or(LegacyQuery::Unknown),
        LegacyQuery::Unknown
    );

    // A frozen D-117 query and reply still decode the same way at the newer end.
    let fixture = include_bytes!("fixtures/v1/request_usage.cbor");
    let LegacyMessage::Request { id, query } = ciborium::from_reader(fixture.as_slice()).unwrap();
    let LegacyQuery::UsageByApp {
        from_ms,
        to_ms,
        by,
        limit,
    } = query.deserialized().unwrap()
    else {
        panic!("the pinned legacy query must decode");
    };
    assert_eq!(
        decode_message(fixture).unwrap(),
        Message::Request {
            id,
            query: Query::UsageByApp {
                from_ms,
                to_ms,
                by,
                limit
            },
        }
    );
    let fixture = include_bytes!("fixtures/v1/reply_error.cbor");
    assert!(matches!(
        decode_message(fixture).unwrap(),
        Message::Reply {
            answer: Answer::Error {
                code: ErrorCode::Unsupported,
                ..
            },
            ..
        }
    ));
}

#[test]
fn a_future_clamp_with_detail_survives_with_the_rest_of_the_history_answer() {
    let mut answer = history_answer(SeriesKey::parse("cpu.total").unwrap());
    let mut body = Value::serialized(&answer).unwrap();
    let Value::Map(fields) = &mut body else {
        panic!("history body must be a map")
    };
    let (_, clamped) = fields
        .iter_mut()
        .find(|(key, _)| key.as_text() == Some("clamped"))
        .unwrap();
    let Value::Array(clamps) = clamped else {
        panic!("clamped must be an array")
    };
    clamps.push(Value::Map(vec![
        ("kind".into(), "future_limit".into()),
        (
            "detail".into(),
            Value::Array(vec![Value::Integer(2.into())]),
        ),
    ]));
    let message = Value::Map(vec![
        ("t".into(), "Reply".into()),
        (
            "c".into(),
            Value::Map(vec![
                ("id".into(), Value::Integer(2.into())),
                (
                    "answer".into(),
                    Value::Map(vec![("a".into(), "History".into()), ("v".into(), body)]),
                ),
            ]),
        ),
    ]);
    let mut bytes = Vec::new();
    ciborium::into_writer(&message, &mut bytes).unwrap();
    answer.clamped.push(HistoryClamp::Unknown);
    assert_eq!(
        decode_message(&bytes).unwrap(),
        Message::Reply {
            id: 2,
            answer: Answer::History(answer)
        }
    );
}

#[test]
fn range_totals_are_optional_in_both_directions() {
    // What a host before range totals sent, and what a phone before them reads.
    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    struct LegacyStats {
        key: SeriesKey,
        avg: Option<f32>,
        peak: Option<f32>,
    }

    let key = SeriesKey::parse("net.rx_total").unwrap();
    let legacy = LegacyStats {
        key: key.clone(),
        avg: Some(24.0),
        peak: Some(30.0),
    };
    let mut bytes = Vec::new();
    ciborium::into_writer(&legacy, &mut bytes).unwrap();
    let decoded: WireSeriesStats = ciborium::from_reader(bytes.as_slice()).unwrap();
    assert_eq!(
        decoded,
        WireSeriesStats {
            key: key.clone(),
            avg: Some(24.0),
            peak: Some(30.0),
            measured_ms: None,
            integral: None,
        }
    );

    let current = WireSeriesStats {
        key,
        avg: Some(24.0),
        peak: Some(30.0),
        measured_ms: Some(20_000),
        integral: Some(480.0),
    };
    let mut bytes = Vec::new();
    ciborium::into_writer(&current, &mut bytes).unwrap();
    let older: LegacyStats = ciborium::from_reader(bytes.as_slice()).unwrap();
    assert_eq!(older, legacy);
}
