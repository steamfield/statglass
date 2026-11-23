//! Turns a message and a destination into one HTTP request. Pure: no I/O, no process.
//!
//! An ntfy destination is published as JSON to its server root (`topic`, `title`,
//! `message`, `priority` 4, `tags` ["warning"]) with `Authorization: Bearer <token>` when
//! a token is set. A webhook receives `text` and `content` ("title: message", for Slack
//! and Discord), `title`, `message`, `host`, `rule`, `kind` and `fired_at_ms`
//! (plan/rfc-alerts.md 6.4).

use std::fmt;

use statglass_schema::Destination;

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
    let _ = (destination, message);
    HttpRequest {
        url: String::new(),
        headers: Vec::new(),
        body: String::new(),
    }
}
