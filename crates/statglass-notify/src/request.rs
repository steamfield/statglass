//! Turns a message and a destination into one HTTP request. Pure: no I/O, no process.
//!
//! An ntfy destination is published as JSON to its server root (`topic`, `title`,
//! `message`, `priority` 4, `tags` ["warning"]) with `Authorization: Bearer <token>` when
//! a token is set. A webhook receives `text` and `content` ("title: message", for Slack
//! and Discord), `title`, `message`, `host`, `rule`, `kind` and `fired_at_ms`
//! (plan/rfc-alerts.md 6.4).

use std::fmt;

use statglass_schema::{Destination, DestinationKind};

use crate::text::AlertText;

/// What is sent to a destination: an alert's text plus where and when it fired.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub title: String,
    pub body: String,
    /// The host's display name ("Riley's MacBook Pro").
    pub host: String,
    /// The rule that fired, `None` for a message no rule sent (a test).
    pub rule: Option<String>,
    /// What the message is about: the `AlertCause` serde tag, as in [`AlertText::kind`].
    pub kind: String,
    /// When the alert fired, wall-clock ms.
    pub fired_at_ms: i64,
}

impl Message {
    /// The message for a fired alert: the title, body, rule and kind of `text`, with the
    /// host's display name and the alert's time. The single mapping from [`AlertText`],
    /// so a sender never reads the event again.
    pub fn from_alert_text(text: AlertText, host: &str, fired_at_ms: i64) -> Message {
        let AlertText {
            title,
            body,
            rule,
            kind,
        } = text;
        Message {
            title,
            body,
            host: host.to_owned(),
            rule,
            kind: kind.to_owned(),
            fired_at_ms,
        }
    }
}

/// One POST: where it goes, its headers and its body. The URL and the header values can
/// hold a secret, so `Debug` shows only the header names and the body length.
#[derive(Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("HttpRequest")
            .field("headers", &names)
            .field("body_len", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// The request that delivers `message` to `destination`. Does not validate: callers
/// check [`Destination::validate`] first.
pub fn build_request(destination: &Destination, message: &Message) -> HttpRequest {
    match &destination.kind {
        DestinationKind::Ntfy {
            server,
            topic,
            token,
        } => ntfy_request(server, topic, token.as_deref(), message),
        DestinationKind::Webhook { url } => webhook_request(url, message),
    }
}

/// ntfy's "high" priority: the phone sounds and shows the message at once.
const NTFY_PRIORITY: u8 = 4;
/// The ntfy tag, shown as a warning sign in front of the title.
const NTFY_TAG: &str = "warning";

/// The `Content-Type` header every request carries.
fn json_content_type() -> (String, String) {
    ("Content-Type".to_owned(), "application/json".to_owned())
}

/// An ntfy publish: JSON to the server root, with a bearer token when one is set.
fn ntfy_request(server: &str, topic: &str, token: Option<&str>, message: &Message) -> HttpRequest {
    let mut headers = vec![json_content_type()];
    if let Some(token) = token.filter(|token| !token.is_empty()) {
        headers.push(("Authorization".to_owned(), format!("Bearer {token}")));
    }
    let body = format!(
        r#"{{"topic":{},"title":{},"message":{},"priority":{NTFY_PRIORITY},"tags":[{}]}}"#,
        json_string(topic),
        json_string(&message.title),
        json_string(&message.body),
        json_string(NTFY_TAG),
    );
    HttpRequest {
        url: format!("{}/", server.trim_end_matches('/')),
        headers,
        body,
    }
}

/// A webhook POST carrying every message field, plus `text` and `content` ("title:
/// message") for Slack and Discord.
fn webhook_request(url: &str, message: &Message) -> HttpRequest {
    let summary = json_string(&format!("{}: {}", message.title, message.body));
    let rule = message
        .rule
        .as_deref()
        .map_or_else(|| "null".to_owned(), json_string);
    let body = format!(
        r#"{{"text":{summary},"content":{summary},"title":{},"message":{},"host":{},"rule":{rule},"kind":{},"fired_at_ms":{}}}"#,
        json_string(&message.title),
        json_string(&message.body),
        json_string(&message.host),
        json_string(&message.kind),
        message.fired_at_ms,
    );
    HttpRequest {
        url: url.to_owned(),
        headers: vec![json_content_type()],
        body,
    }
}

/// `text` as a JSON string literal (RFC 8259): quoted, with quote and backslash escaped,
/// newline, carriage return and tab written as `\n`, `\r` and `\t`, and every other
/// character below U+0020 as `\u00XX`. Everything else, non-ASCII included, passes
/// through as is.
fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::json_string;

    #[test]
    fn quotes_and_backslashes_are_escaped() {
        assert_eq!(json_string(r#"a "b" \c"#), r#""a \"b\" \\c""#);
        assert_eq!(json_string(r"trailing \"), r#""trailing \\""#);
        assert_eq!(json_string(""), r#""""#);
    }

    #[test]
    fn every_control_character_below_space_is_escaped() {
        for code in 0_u32..0x20 {
            let c = char::from_u32(code).unwrap();
            let expected = match c {
                '\n' => r#""\n""#.to_owned(),
                '\r' => r#""\r""#.to_owned(),
                '\t' => r#""\t""#.to_owned(),
                _ => format!(r#""\u{code:04x}""#),
            };
            assert_eq!(json_string(&c.to_string()), expected, "U+{code:04X}");
        }
    }

    #[test]
    fn non_ascii_and_printable_text_pass_through_unescaped() {
        // A Rust `str` is always valid UTF-8, so a lone surrogate cannot reach here.
        for text in [
            "Memory pressure 84% · above 80%",
            "Température 95 °C",
            "日本語 🚨",
            "a/b <c> {d} ~ \u{7f}",
        ] {
            assert_eq!(json_string(text), format!("\"{text}\""));
        }
    }
}
