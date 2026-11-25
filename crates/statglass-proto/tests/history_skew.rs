use ciborium::Value;
use statglass_proto::{
    Answer, HistoryAnswer, HistoryClamp, HistoryQuery, Message, Query, WireEvent,
    WireHistorySeries, WireSeriesStats, decode_message, encode_message,
};
use statglass_schema::{Module, SeriesKey, SeriesSelector, Tier};

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
        }],
        clamped: vec![HistoryClamp::Points],
    }
}

#[test]
fn history_request_and_reply_round_trip() {
    let key = SeriesKey::parse("cpu.total").unwrap();
    for message in [
        Message::Request {
            id: 1,
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
        },
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
