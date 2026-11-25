use ciborium::Value;
use statglass_proto::{
    Answer, HostAddresses, Message, PublicIp, Query, decode_message, encode_message,
};

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
        ("state".into(), "future_state".into()),
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
