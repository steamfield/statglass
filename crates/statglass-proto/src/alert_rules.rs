//! A host's custom alert rules on the wire (plan/rfc-remote-alerts.md 5.1): what
//! `Query::AlertRules` and `Query::SetAlertRules` carry. A one-way door like the rest of
//! the wire.
//!
//! Rules travel as individually decoded entries. `lenient` turns a whole query or answer
//! into `Unknown` when any part fails to decode, so one rule from a newer build (a new
//! condition) would otherwise make the whole list unreadable. An entry this build cannot
//! decode is carried as raw CBOR and re-encodes unchanged.

use serde::{Deserialize, Serialize};
use statglass_schema::AlertRule;

/// The custom rules a host evaluates, with the revision a later `SetAlertRules` must name.
///
/// `revision` is opaque to the controller: the host derives it from the rule list's
/// content, so it survives a host restart, and keeps it below 2^53 so it crosses to
/// TypeScript as a number.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostAlertRules {
    pub revision: i64,
    pub rules: Vec<RuleEntry>,
}

/// One rule entry: a rule this build decodes, or the raw CBOR of one it does not.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuleEntry {
    Known(AlertRule),
    Unknown(ciborium::Value),
}
