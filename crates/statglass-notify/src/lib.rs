//! What an alert says, for every place that says it (the macOS notification posted by
//! the app shell, the message sent to each destination, later the Linux agent), and how
//! a message reaches a destination through the system's curl (plan/rfc-alerts.md 6.1,
//! 6.4). Depends on `statglass-schema` only, so it carries no Tauri or platform code.
//!
//! | Need | Item |
//! |---|---|
//! | A rule as a sentence ("Memory pressure above 80% for 2 min") | [`rule_summary`] |
//! | Title and body for a fired alert | [`alert_text`] |
//! | Text for a remote alert or a batch of late remote alerts | [`remote_alert_text`], [`catch_up_text`] |
//! | The "Alerts are on" confirmation | [`alerts_on_text`] |
//! | A metric value in the user's units | [`format_value`] |
//! | What is sent for an alert | [`Message::from_alert_text`] |
//! | The HTTP request for a destination | [`build_request`] |
//! | One attempt through curl | [`curl::run`], [`curl::config_text`], [`curl::arguments`] |
//! | A delivery with retries | [`deliver`], [`DeliverOptions`] |

pub mod curl;
mod deliver;
mod request;
mod text;
mod units;

pub use deliver::{DeliverOptions, deliver};
pub use request::{HttpRequest, Message, build_request};
pub use text::{
    AlertText, alert_text, alerts_on_text, catch_up_text, remote_alert_text, rule_summary,
};
pub use units::format_value;
