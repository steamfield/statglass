//! Alert settings: the switches of the built-in rules and the user's custom threshold
//! rules (plan/rfc-alerts.md 6.2). Custom rules are validated when a patch is applied
//! ([`AlertSettings::validate`]); on load, a rule that does not decode or no longer
//! validates is dropped ([`AlertSettings::drop_invalid`]) so one stale rule never resets
//! every setting.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::alert::{AlertRule, AlertRuleError};

/// The built-in alert rules, each off until the user turns it on, and the custom rules.
/// Turning a rule on posts a one-off "Alerts are on" notification: macOS asks for
/// notification permission on a first delivery, not when the app asks (D-084), so this
/// brings the prompt up while the user is looking rather than with the first real alert.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct AlertSettings {
    /// [`AlertRule::hot_process`]: a process above 200% CPU for 5 minutes.
    pub hot_process: bool,
    /// [`AlertRule::thermal_serious`]: thermal state Serious or worse.
    pub thermal_serious: bool,
    /// A saved host offline for 5 minutes. Absent from a file written before custom
    /// rules: off.
    #[serde(default)]
    pub host_offline: bool,
    /// The user's threshold rules, at most [`AlertRule::MAX_CUSTOM`]. Absent from a file
    /// written before custom rules: none. An entry this build cannot decode (a condition
    /// from a newer build) is skipped on load.
    #[serde(default, deserialize_with = "known_rules")]
    #[specta(type = Vec<AlertRule>)]
    pub rules: Vec<AlertRule>,
}

/// `deserialize_with` for [`AlertSettings::rules`]: decodes each entry on its own and
/// skips one that does not decode, as `deserialize_known_modules` drops unknown modules.
fn known_rules<'de, D>(deserializer: D) -> Result<Vec<AlertRule>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<StoredRule>::deserialize(deserializer)?;
    Ok(entries
        .into_iter()
        .filter_map(|entry| match entry {
            StoredRule::Known(rule) => Some(rule),
            StoredRule::Unknown(_) => None,
        })
        .collect())
}

/// One stored rule entry: a rule this build decodes, or anything else (a condition
/// from a newer build), which is read and set aside.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredRule {
    Known(AlertRule),
    Unknown(serde::de::IgnoredAny),
}

/// Admits `rule` into the custom list whose ids so far are `kept`: it must pass
/// [`AlertRule::validate_custom`], not repeat a kept id, and fit under
/// [`AlertRule::MAX_CUSTOM`]. On success its id joins `kept`.
fn admit(rule: &AlertRule, kept: &mut HashSet<Uuid>) -> Result<(), AlertRuleError> {
    rule.validate_custom()?;
    if kept.contains(&rule.id) {
        return Err(AlertRuleError::DuplicateId);
    }
    if kept.len() >= AlertRule::MAX_CUSTOM {
        return Err(AlertRuleError::TooMany);
    }
    kept.insert(rule.id);
    Ok(())
}

impl AlertSettings {
    /// The built-in rules, each with `enabled` from these settings.
    pub fn builtin_rules(&self) -> [AlertRule; 2] {
        [
            AlertRule {
                enabled: self.hot_process,
                ..AlertRule::hot_process()
            },
            AlertRule {
                enabled: self.thermal_serious,
                ..AlertRule::thermal_serious()
            },
        ]
    }

    /// Every rule the engine evaluates: the built-in rules, then the custom rules, each
    /// with its own `enabled` flag.
    pub fn engine_rules(&self) -> Vec<AlertRule> {
        self.builtin_rules()
            .into_iter()
            .chain(self.rules.iter().cloned())
            .collect()
    }

    /// Checks the custom rules on the patch path: each passes
    /// [`AlertRule::validate_custom`], no two share an id, and there are at most
    /// [`AlertRule::MAX_CUSTOM`]. The first problem found is returned.
    pub fn validate(&self) -> Result<(), AlertRuleError> {
        let mut kept = HashSet::new();
        self.rules
            .iter()
            .try_for_each(|rule| admit(rule, &mut kept))
    }

    /// Removes, on the load path, every custom rule that fails
    /// [`AlertRule::validate_custom`], every later rule with an id already seen, and every
    /// rule past [`AlertRule::MAX_CUSTOM`], and returns each removed rule's id with why.
    /// Afterwards [`Self::validate`] passes.
    pub fn drop_invalid(&mut self) -> Vec<(Uuid, AlertRuleError)> {
        let mut kept = HashSet::new();
        let mut dropped = Vec::new();
        self.rules.retain(|rule| match admit(rule, &mut kept) {
            Ok(()) => true,
            Err(reason) => {
                dropped.push((rule.id, reason));
                false
            }
        });
        dropped
    }
}

#[cfg(test)]
#[path = "alerts_tests.rs"]
mod tests;
