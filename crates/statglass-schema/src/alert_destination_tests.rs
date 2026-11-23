//! [`Destination::validate`]: what a destination may hold before it is saved or sent to,
//! one test per rule, each with a value just inside and just outside the limit.

use uuid::Uuid;

use super::*;

fn ntfy(server: &str, topic: &str, token: Option<&str>) -> Destination {
    Destination {
        id: Uuid::from_u128(0xde57),
        name: "Phone".into(),
        enabled: true,
        kind: DestinationKind::Ntfy {
            server: server.into(),
            topic: topic.into(),
            token: token.map(Into::into),
        },
    }
}

fn webhook(url: &str) -> Destination {
    Destination {
        id: Uuid::from_u128(0xde58),
        name: "Team chat".into(),
        enabled: true,
        kind: DestinationKind::Webhook { url: url.into() },
    }
}

fn named(name: &str) -> Destination {
    Destination {
        name: name.into(),
        ..ntfy("https://ntfy.sh", "statglass-4f2a", None)
    }
}

/// An http(s) URL of exactly `len` characters with a host.
fn url_of_len(len: usize) -> String {
    let base = "https://hooks.example.com/";
    format!("{base}{}", "a".repeat(len - base.len()))
}

#[test]
fn a_name_is_1_to_40_characters_after_trimming() {
    for ok in [
        "P",
        "Phone",
        "  Phone  ",
        &"n".repeat(40),
        &format!(" {} ", "n".repeat(40)),
    ] {
        assert_eq!(named(ok).validate(), Ok(()), "{ok:?}");
    }
    for bad in ["", "   ", "\t", &"n".repeat(41)] {
        assert_eq!(
            named(bad).validate(),
            Err(DestinationError::Name),
            "{bad:?}"
        );
    }
    // Characters, not bytes: 40 accented letters are 80 bytes.
    assert_eq!(named(&"é".repeat(40)).validate(), Ok(()));
}

#[test]
fn a_server_or_webhook_url_must_be_http_or_https_with_a_host() {
    for ok in [
        "https://ntfy.sh",
        "http://ntfy.local:8080",
        "https://ntfy.example.com/",
    ] {
        assert_eq!(ntfy(ok, "alerts", None).validate(), Ok(()), "{ok:?}");
    }
    for ok in [
        "https://chat.example.com/hooks/T0/B0/xyz",
        "http://192.168.1.20:5000/hook?x=1",
    ] {
        assert_eq!(webhook(ok).validate(), Ok(()), "{ok:?}");
    }
    for bad in [
        "",
        "ntfy.sh",
        "ftp://ntfy.sh",
        "file:///etc/hosts",
        "https://",
        "http:///path",
        "HTTPS//ntfy.sh",
        "javascript:alert(1)",
    ] {
        assert_eq!(
            ntfy(bad, "alerts", None).validate(),
            Err(DestinationError::Url),
            "server {bad:?}"
        );
        assert_eq!(
            webhook(bad).validate(),
            Err(DestinationError::Url),
            "url {bad:?}"
        );
    }
}

#[test]
fn a_url_is_at_most_2048_characters() {
    assert_eq!(webhook(&url_of_len(2048)).validate(), Ok(()));
    assert_eq!(
        webhook(&url_of_len(2049)).validate(),
        Err(DestinationError::Url)
    );
    assert_eq!(
        ntfy(&url_of_len(2049), "alerts", None).validate(),
        Err(DestinationError::Url)
    );
}

#[test]
fn a_url_holds_no_whitespace_control_character_quote_or_backslash() {
    for bad in [
        "https://hooks.example.com/a b",
        "https://hooks.example.com/a\tb",
        "https://hooks.example.com/a\nurl = \"http://evil\"",
        "https://hooks.example.com/a\rb",
        "https://hooks.example.com/a\u{7}b",
        "https://hooks.example.com/a\u{7f}b",
        "https://hooks.example.com/a\"b",
        "https://hooks.example.com/a\\b",
        " https://hooks.example.com/",
    ] {
        assert_eq!(
            webhook(bad).validate(),
            Err(DestinationError::Url),
            "{bad:?}"
        );
        assert_eq!(
            ntfy(bad, "alerts", None).validate(),
            Err(DestinationError::Url),
            "server {bad:?}"
        );
    }
    assert_eq!(
        webhook("https://hooks.example.com/a-b_c~d%20e").validate(),
        Ok(())
    );
}

#[test]
fn a_topic_is_1_to_64_letters_digits_hyphens_or_underscores() {
    for ok in ["a", "statglass-4f2a", "Mac_Alerts-01", &"t".repeat(64)] {
        assert_eq!(
            ntfy("https://ntfy.sh", ok, None).validate(),
            Ok(()),
            "{ok:?}"
        );
    }
    for bad in [
        "",
        &"t".repeat(65),
        "my topic",
        "topic/sub",
        "topic.dot",
        "tópico",
        "a\"b",
        "a\nb",
    ] {
        assert_eq!(
            ntfy("https://ntfy.sh", bad, None).validate(),
            Err(DestinationError::Topic),
            "{bad:?}"
        );
    }
}

#[test]
fn a_token_is_at_most_256_characters_without_whitespace_or_control_characters() {
    for ok in ["tk_example_0123456789", &"k".repeat(256), "a\"b\\c"] {
        assert_eq!(
            ntfy("https://ntfy.sh", "alerts", Some(ok)).validate(),
            Ok(()),
            "{ok:?}"
        );
    }
    for bad in [
        &"k".repeat(257),
        "tk 123",
        "tk\t123",
        "tk\n123",
        "tk\r123",
        "tk\u{0}123",
        " tk",
    ] {
        assert_eq!(
            ntfy("https://ntfy.sh", "alerts", Some(bad)).validate(),
            Err(DestinationError::Token),
            "{bad:?}"
        );
    }
}

#[test]
fn an_empty_token_counts_as_no_token() {
    assert_eq!(
        ntfy("https://ntfy.sh", "alerts", Some("")).validate(),
        Ok(())
    );
    assert_eq!(ntfy("https://ntfy.sh", "alerts", None).validate(), Ok(()));
}

#[test]
fn each_error_states_its_rule_without_the_refused_value() {
    assert_eq!(
        DestinationError::Name.to_string(),
        "destination name must be 1 to 40 characters"
    );
    assert_eq!(
        DestinationError::Url.to_string(),
        "address must start with http:// or https://, name a host, and be at most 2048 characters with no spaces, quotes or backslashes"
    );
    assert_eq!(
        DestinationError::Topic.to_string(),
        "topic must be 1 to 64 letters, digits, hyphens or underscores"
    );
    assert_eq!(
        DestinationError::Token.to_string(),
        "access token must be at most 256 characters with no spaces"
    );
}

#[test]
fn debug_output_leaves_out_the_server_topic_token_and_url() {
    let shown = format!(
        "{:?} {:?}",
        ntfy(
            "https://ntfy.private.example",
            "topic-private",
            Some("tk_private")
        ),
        webhook("https://hooks.example.com/private-path")
    );
    for private in [
        "ntfy.private",
        "topic-private",
        "tk_private",
        "private-path",
    ] {
        assert!(!shown.contains(private), "{shown}");
    }
}

#[test]
fn destinations_and_outcomes_have_the_json_shape_the_client_reads() {
    let json = serde_json::to_value(ntfy("https://ntfy.sh", "alerts", None)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "id": "00000000-0000-0000-0000-00000000de57",
            "name": "Phone",
            "enabled": true,
            "kind": { "type": "ntfy", "server": "https://ntfy.sh", "topic": "alerts", "token": null }
        })
    );
    let record = DeliveryRecord {
        at_ms: 1_800_000_000_000,
        outcome: DeliveryOutcome::Failed {
            reason: DeliveryFailure::Http,
            detail: "HTTP 403".into(),
        },
    };
    assert_eq!(
        serde_json::to_value(&record).unwrap(),
        serde_json::json!({
            "at_ms": 1_800_000_000_000_i64,
            "outcome": { "kind": "failed", "reason": "http", "detail": "HTTP 403" }
        })
    );
    let back: Destination = serde_json::from_value(json).unwrap();
    assert_eq!(back, ntfy("https://ntfy.sh", "alerts", None));
}
