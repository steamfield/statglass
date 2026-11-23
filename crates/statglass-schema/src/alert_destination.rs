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
        Err(DestinationError::Name)
    }
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

#[cfg(test)]
#[path = "alert_destination_tests.rs"]
mod tests;
