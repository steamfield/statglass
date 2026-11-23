//! What an alert says, for every place that says it: the macOS notification posted by
//! the app shell, and (later) the message sent to each destination and by the Linux
//! agent (plan/rfc-alerts.md 6.1). Depends on `statglass-schema` only, so it carries no
//! Tauri or platform code.
//!
//! | Need | Item |
//! |---|---|
//! | A rule as a sentence ("Memory pressure above 80% for 2 min") | [`rule_summary`] |
//! | Title and body for a fired alert | [`alert_text`] |
//! | The "Alerts are on" confirmation | [`alerts_on_text`] |
//! | A metric value in the user's units | [`format_value`] |

mod text;
mod units;

pub use text::{AlertText, alert_text, alerts_on_text, rule_summary};
pub use units::format_value;
