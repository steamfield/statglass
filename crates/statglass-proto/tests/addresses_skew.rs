use ciborium::Value;
use serde::{Deserialize, Deserializer, Serialize};
use statglass_proto::{
    Answer, ErrorCode, HostAddresses, Message, PublicIp, Query, decode_message, encode_message,
};

/// The pre-addresses tags needed to read this request, including its unknown-query
/// fallback. A frozen pre-change request below also exercises the known variant.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "q", content = "a")]
enum OldQuery {
    SpaceSubtree {
        report: u32,
        node: Option<u32>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "t", content = "c")]
enum OldMessage {
    Request {
        id: u32,
        #[serde(deserialize_with = "old_lenient")]
        query: OldQuery,
    },
}

fn old_lenient<'de, D: Deserializer<'de>>(d: D) -> Result<OldQuery, D::Error> {
    let query = Value::deserialize(d)?;
    Ok(query.deserialized().unwrap_or(OldQuery::Unknown))
}

#[derive(Serialize)]
#[serde(tag = "t", content = "c")]
enum OldReply {
    Reply { id: u32, answer: OldAnswer },
}

#[derive(Serialize)]
#[serde(tag = "a", content = "v")]
enum OldAnswer {
    Error {
        code: ErrorCode,
        message: &'static str,
    },
}

const OLD_REQUEST: &[u8] = include_bytes!("fixtures/v1/request_space_subtree.cbor");
const OLD_REFUSAL: &[u8] = include_bytes!("fixtures/v1/reply_error.cbor");

fn addresses() -> HostAddresses {
    HostAddresses {
        interface: Some("en0".into()),
        link_mbps: Some(1000),
        ipv4: vec!["192.0.2.10".parse().expect("test IPv4")],
        ipv6: vec!["2001:db8::1".parse().expect("test IPv6")],
        public_ip: PublicIp::Known {
            ip: "203.0.113.10".parse().expect("test public IP"),
        },
        as_of_ms: 30_000,
    }
}

#[test]
fn addresses_request_and_reply_round_trip() {
    for message in [
        Message::Request {
            id: 1,
            query: Query::NetworkAddresses,
        },
        Message::Reply {
            id: 1,
            answer: Answer::NetworkAddresses(addresses()),
        },
    ] {
        assert_eq!(
            decode_message(&encode_message(&message).unwrap()).unwrap(),
            message
        );
    }
}

#[test]
fn addresses_requests_decode_as_unknown_on_old_hosts_and_old_refusals_still_decode() {
    let request = encode_message(&Message::Request {
        id: 8,
        query: Query::NetworkAddresses,
    })
    .unwrap();
    let OldMessage::Request {
        id,
        query: OldQuery::Unknown,
    } = ciborium::from_reader(request.as_slice()).unwrap()
    else {
        panic!("the old host should decode the query as unknown");
    };
    let mut refusal = Vec::new();
    ciborium::into_writer(
        &OldReply::Reply {
            id,
            answer: OldAnswer::Error {
                code: ErrorCode::Unsupported,
                message: "not answered by this host",
            },
        },
        &mut refusal,
    )
    .unwrap();
    assert_eq!(refusal, OLD_REFUSAL);
    assert_eq!(
        decode_message(&refusal).unwrap(),
        Message::Reply {
            id: 8,
            answer: Answer::Error {
                code: ErrorCode::Unsupported,
                message: "not answered by this host".into(),
            },
        }
    );
}

#[test]
fn addresses_capable_hosts_still_decode_a_pre_addresses_request() {
    assert_eq!(
        ciborium::from_reader::<OldMessage, _>(OLD_REQUEST).unwrap(),
        OldMessage::Request {
            id: 8,
            query: OldQuery::SpaceSubtree {
                report: 3,
                node: Some(12)
            },
        }
    );
    assert_eq!(
        decode_message(OLD_REQUEST).unwrap(),
        Message::Request {
            id: 8,
            query: Query::SpaceSubtree {
                report: 3,
                node: Some(12)
            },
        }
    );
}

#[test]
fn known_public_ip_decodes_when_detail_precedes_state() {
    let expected = addresses();
    let mut body = Value::serialized(&expected).unwrap();
    let Value::Map(fields) = &mut body else {
        panic!("addresses body must be a map");
    };
    let (_, public_ip) = fields
        .iter_mut()
        .find(|(key, _)| key.as_text() == Some("public_ip"))
        .unwrap();
    let Value::Map(fields) = public_ip else {
        panic!("public IP must be a map");
    };
    assert_eq!(
        fields.first().and_then(|(key, _)| key.as_text()),
        Some("state")
    );
    fields.reverse();
    assert_eq!(body.deserialized::<HostAddresses>().unwrap(), expected);
}

#[test]
fn a_future_public_ip_state_with_detail_preserves_the_address_answer() {
    let mut addresses = addresses();
    let mut body = Value::serialized(&addresses).unwrap();
    let Value::Map(fields) = &mut body else {
        panic!("addresses body must be a map")
    };
    let (_, public_ip) = fields
        .iter_mut()
        .find(|(key, _)| key.as_text() == Some("public_ip"))
        .unwrap();
    *public_ip = Value::Map(vec![
        ("state".into(), "via_stun".into()),
        (
            "detail".into(),
            Value::Map(vec![("hint".into(), "new field".into())]),
        ),
    ]);
    let message = Value::Map(vec![
        ("t".into(), "Reply".into()),
        (
            "c".into(),
            Value::Map(vec![
                ("id".into(), Value::Integer(2.into())),
                (
                    "answer".into(),
                    Value::Map(vec![
                        ("a".into(), "NetworkAddresses".into()),
                        ("v".into(), body),
                    ]),
                ),
            ]),
        ),
    ]);
    let mut bytes = Vec::new();
    ciborium::into_writer(&message, &mut bytes).unwrap();
    addresses.public_ip = PublicIp::Unknown;
    assert_eq!(
        decode_message(&bytes).unwrap(),
        Message::Reply {
            id: 2,
            answer: Answer::NetworkAddresses(addresses)
        }
    );
}
