//! The retry policy: one delivery is up to three attempts through [`crate::curl::run`],
//! retried only when trying again can help (a network failure or a 5xx answer).
//! Synchronous; callers run it off their own thread.

use std::path::PathBuf;
use std::time::Duration;

use statglass_schema::{DeliveryOutcome, Destination};

use crate::request::Message;

/// How [`deliver`] sends: which curl, how long one attempt may take, and the waits
/// before the second and third attempts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliverOptions {
    pub curl: PathBuf,
    pub timeout_secs: u32,
    pub backoff: [Duration; 2],
}

impl Default for DeliverOptions {
    /// `/usr/bin/curl`, 10 s per attempt, retries after 2 s and 10 s.
    fn default() -> Self {
        Self {
            curl: PathBuf::from("/usr/bin/curl"),
            timeout_secs: 10,
            backoff: [Duration::from_secs(2), Duration::from_secs(10)],
        }
    }
}

/// Delivers `message` to `destination`: an invalid destination is
/// `Failed { Rejected }` without sending; otherwise up to three attempts, sleeping
/// `backoff[0]` then `backoff[1]` between them, retrying only `ConnectFailed`,
/// `NameNotFound`, `TimedOut` and an HTTP 5xx answer. Returns the last attempt's
/// outcome. Blocking.
pub fn deliver(
    destination: &Destination,
    message: &Message,
    options: &DeliverOptions,
) -> DeliveryOutcome {
    let _ = (destination, message, options);
    crate::curl::not_implemented()
}
