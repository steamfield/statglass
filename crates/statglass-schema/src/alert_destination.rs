//! Where fired alerts are sent, as plain data: a [`Destination`] (an ntfy topic or a
//! webhook), the rules a destination must pass before it is saved, and what one delivery
//! attempt came to ([`DeliveryOutcome`], [`DeliveryRecord`]). Sending lives in
//! `statglass-notify`, persistence in the app shell (plan/rfc-alerts.md 6.1, 6.4).
//!
//! A destination's server, topic, token and URL are secrets: they are never logged or
//! formatted into a message, and the `Debug` output of these types leaves them out.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The most destinations one Mac keeps.
pub const MAX_DESTINATIONS: usize = 8;

/// One place a fired alert is sent to, saved in `alert-destinations.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Destination {
    pub id: Uuid,
    /// What the user calls it ("Phone"). 1 to [`Destination::MAX_NAME_CHARS`]
    /// characters after trimming.
    pub name: String,
    /// A disabled destination is kept but receives nothing.
    pub enabled: bool,
    pub kind: DestinationKind,
}

/// How a destination is reached.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DestinationKind {
    /// An ntfy server (`https://ntfy.sh` or self-hosted) and topic, with an access token
    /// for a protected topic. An empty token counts as no token.
    Ntfy {
        server: String,
        topic: String,
        token: Option<String>,
    },
    /// Any URL that accepts a JSON POST (Slack and Discord incoming webhooks read its
    /// `text` and `content` fields).
    Webhook { url: String },
}

impl fmt::Debug for DestinationKind {
    /// The variant only: the server, topic, token and URL are secrets.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Ntfy { .. } => "Ntfy",
            Self::Webhook { .. } => "Webhook",
        };
        f.debug_struct(name).finish_non_exhaustive()
    }
}

impl Destination {
    /// The longest destination name, in characters after trimming.
    pub const MAX_NAME_CHARS: usize = 40;
    /// The longest ntfy server or webhook URL, in characters.
    pub const MAX_URL_CHARS: usize = 2048;
    /// The longest ntfy topic, in characters.
    pub const MAX_TOPIC_CHARS: usize = 64;
    /// The longest ntfy access token, in characters.
    pub const MAX_TOKEN_CHARS: usize = 256;

    /// Checks a destination before it is saved or sent to: a name of 1 to
    /// [`Self::MAX_NAME_CHARS`] characters after trimming; an ntfy server or webhook URL
    /// that starts with `http://` or `https://`, names a host, is at most
    /// [`Self::MAX_URL_CHARS`] characters and holds no whitespace, control character,
    /// quote or backslash; a topic of 1 to [`Self::MAX_TOPIC_CHARS`] of `[A-Za-z0-9_-]`;
    /// a token of at most [`Self::MAX_TOKEN_CHARS`] characters with no whitespace or
    /// control character (an empty token is no token).
    pub fn validate(&self) -> Result<(), DestinationError> {
        let name_chars = self.name.trim().chars().count();
        if !(1..=Self::MAX_NAME_CHARS).contains(&name_chars) {
            return Err(DestinationError::Name);
        }
        match &self.kind {
            DestinationKind::Ntfy {
                server,
                topic,
                token,
            } => {
                if !is_valid_url(server) {
                    return Err(DestinationError::Url);
                }
                if !is_valid_topic(topic) {
                    return Err(DestinationError::Topic);
                }
                match token.as_deref() {
                    Some(token) if !is_valid_token(token) => Err(DestinationError::Token),
                    _ => Ok(()),
                }
            }
            DestinationKind::Webhook { url } => {
                if is_valid_url(url) {
                    Ok(())
                } else {
                    Err(DestinationError::Url)
                }
            }
        }
    }
}

/// An http or https URL that names a host, fits [`Destination::MAX_URL_CHARS`] and holds
/// no whitespace, control character, quote or backslash. The scheme is matched in lower
/// case only, as every address the destination dialog produces is.
fn is_valid_url(url: &str) -> bool {
    let forbidden = |c: char| c.is_whitespace() || c.is_control() || c == '"' || c == '\\';
    if url.chars().count() > Destination::MAX_URL_CHARS || url.contains(forbidden) {
        return false;
    }
    let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    is_valid_authority(authority)
}

/// A host with an optional numeric port, and no user name or password: credentials
/// belong in the ntfy token field, and a URL carrying them would be shown and logged by
/// host. A non-numeric port also refuses userinfo whose password holds a `/`
/// (`https://user:pa/ss@host/x`), where the cut at the first `/` leaves `user:pa`.
fn is_valid_authority(authority: &str) -> bool {
    if authority.contains('@') {
        return false;
    }
    let (host, port) = match authority.strip_prefix('[') {
        // An IPv6 literal: `[::1]` or `[::1]:8080`.
        Some(bracketed) => match bracketed.split_once(']') {
            Some((address, "")) => (address, None),
            Some((address, after)) => match after.strip_prefix(':') {
                Some(port) => (address, Some(port)),
                None => return false,
            },
            None => return false,
        },
        None => match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    let port_is_valid = port.is_none_or(|port| {
        (1..=5).contains(&port.len()) && port.chars().all(|c| c.is_ascii_digit())
    });
    !host.is_empty() && port_is_valid
}

/// 1 to [`Destination::MAX_TOPIC_CHARS`] ASCII letters, digits, hyphens or underscores.
fn is_valid_topic(topic: &str) -> bool {
    let allowed = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    (1..=Destination::MAX_TOPIC_CHARS).contains(&topic.len()) && topic.chars().all(allowed)
}

/// At most [`Destination::MAX_TOKEN_CHARS`] characters with no whitespace or control
/// character. Empty is valid: it counts as no token.
fn is_valid_token(token: &str) -> bool {
    token.chars().count() <= Destination::MAX_TOKEN_CHARS
        && !token.contains(|c: char| c.is_whitespace() || c.is_control())
}

/// Why a destination was refused. Each message states the rule it broke, so the
/// destination dialog can show it as is; none of them repeats the refused value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DestinationError {
    #[error(
        "destination name must be 1 to {} characters",
        Destination::MAX_NAME_CHARS
    )]
    Name,
    #[error(
        "address must start with http:// or https://, name a host, and be at most {} characters with no spaces, quotes or backslashes",
        Destination::MAX_URL_CHARS
    )]
    Url,
    #[error(
        "topic must be 1 to {} letters, digits, hyphens or underscores",
        Destination::MAX_TOPIC_CHARS
    )]
    Topic,
    #[error(
        "access token must be at most {} characters with no spaces",
        Destination::MAX_TOKEN_CHARS
    )]
    Token,
    /// A save would keep more than [`MAX_DESTINATIONS`]. Returned by the app's
    /// destination service, never by [`Destination::validate`].
    #[error("at most {MAX_DESTINATIONS} destinations can be saved")]
    TooMany,
    /// A change named an id no saved destination has. Returned by the app's destination
    /// service, never by [`Destination::validate`].
    #[error("no saved destination has that id")]
    UnknownId,
}

/// What one delivery to a destination came to, after its retries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeliveryOutcome {
    /// The server answered with this 2xx status.
    Delivered { status: u16 },
    /// Nothing was delivered. `detail` is a short sentence for the destination row
    /// ("HTTP 403", "Timed out after 10 s"); it never holds the URL or a token.
    Failed {
        reason: DeliveryFailure,
        detail: String,
    },
}

/// Why a delivery failed, as far as the caller needs to tell failures apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryFailure {
    /// The curl binary is not where it was expected.
    CurlMissing,
    /// The server's name did not resolve.
    NameNotFound,
    /// The server refused or could not be reached.
    ConnectFailed,
    /// No answer before the timeout.
    TimedOut,
    /// The TLS handshake or certificate check failed.
    Tls,
    /// The server answered with a status other than 2xx (redirects included).
    Http,
    /// Refused before sending: the destination is invalid or a value holds a control
    /// character.
    Rejected,
    /// Anything else; the detail carries curl's message.
    Other,
}

/// The last delivery to a destination: when it finished and what it came to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DeliveryRecord {
    /// When the delivery finished, wall-clock ms. JS-safe (see the crate docs).
    #[specta(type = crate::JsSafeInt)]
    pub at_ms: i64,
    pub outcome: DeliveryOutcome,
}

/// The limits [`Destination::validate`] enforces and the text of every
/// [`DestinationError`], published to TypeScript as `ALERT_DESTINATION_LIMITS` so the
/// mock transport rejects what Rust rejects, in Rust's words.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct DestinationLimits {
    /// [`MAX_DESTINATIONS`].
    pub max_destinations: u32,
    /// [`Destination::MAX_NAME_CHARS`].
    pub max_name_chars: u32,
    /// [`Destination::MAX_URL_CHARS`].
    pub max_url_chars: u32,
    /// [`Destination::MAX_TOPIC_CHARS`].
    pub max_topic_chars: u32,
    /// [`Destination::MAX_TOKEN_CHARS`].
    pub max_token_chars: u32,
    /// Each [`DestinationError`]'s Display text by a stable key ("name", "url",
    /// "topic", "token", "too_many", "unknown_id").
    pub messages: std::collections::BTreeMap<&'static str, String>,
}

/// [`DestinationLimits`] from the constants the validation itself reads.
pub fn destination_limits() -> DestinationLimits {
    let chars = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    DestinationLimits {
        max_destinations: chars(MAX_DESTINATIONS),
        max_name_chars: chars(Destination::MAX_NAME_CHARS),
        max_url_chars: chars(Destination::MAX_URL_CHARS),
        max_topic_chars: chars(Destination::MAX_TOPIC_CHARS),
        max_token_chars: chars(Destination::MAX_TOKEN_CHARS),
        messages: [
            ("name", DestinationError::Name),
            ("url", DestinationError::Url),
            ("topic", DestinationError::Topic),
            ("token", DestinationError::Token),
            ("too_many", DestinationError::TooMany),
            ("unknown_id", DestinationError::UnknownId),
        ]
        .into_iter()
        .map(|(key, error)| (key, error.to_string()))
        .collect(),
    }
}

#[cfg(test)]
#[path = "alert_destination_tests.rs"]
mod tests;

#[cfg(test)]
mod url_tests {
    use super::*;

    fn webhook(url: &str) -> Destination {
        Destination {
            id: Uuid::from_u128(0xde59),
            name: "Hook".into(),
            enabled: true,
            kind: DestinationKind::Webhook { url: url.into() },
        }
    }

    #[test]
    fn a_url_with_a_user_name_or_password_is_refused() {
        for bad in [
            "https://user@hooks.example.com/x",
            "https://user:secret@hooks.example.com/x",
            "https://@hooks.example.com/",
            "https://user:pa/ss@hooks.example.com/x",
            "http://user:secret@[::1]:8080/x",
        ] {
            assert_eq!(
                webhook(bad).validate(),
                Err(DestinationError::Url),
                "{bad:?}"
            );
        }
        // An `@` after the authority is part of the path or query, not userinfo.
        for ok in [
            "https://hooks.example.com/@team",
            "https://hooks.example.com/x?to=a@b",
        ] {
            assert_eq!(webhook(ok).validate(), Ok(()), "{ok:?}");
        }
    }

    #[test]
    fn the_scheme_is_matched_in_lower_case_only() {
        for bad in ["HTTPS://ntfy.sh", "Http://ntfy.sh", "hTTps://ntfy.sh/"] {
            assert_eq!(
                webhook(bad).validate(),
                Err(DestinationError::Url),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_port_is_1_to_5_digits() {
        for ok in [
            "http://ntfy.local:8080",
            "http://[::1]:8080/x",
            "http://[::1]/x",
        ] {
            assert_eq!(webhook(ok).validate(), Ok(()), "{ok:?}");
        }
        for bad in [
            "http://ntfy.local:",
            "http://ntfy.local:port",
            "http://ntfy.local:123456",
            "http://:8080/x",
            "http://[::1/x",
            "http://[::1]x/",
            "http://[]:80/",
        ] {
            assert_eq!(
                webhook(bad).validate(),
                Err(DestinationError::Url),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_service_errors_have_their_own_messages_in_the_limits() {
        let messages = destination_limits().messages;
        assert_eq!(
            messages.get("too_many").map(String::as_str),
            Some("at most 8 destinations can be saved")
        );
        assert_eq!(
            messages.get("unknown_id").map(String::as_str),
            Some("no saved destination has that id")
        );
        assert_eq!(messages.len(), 6);
    }
}
