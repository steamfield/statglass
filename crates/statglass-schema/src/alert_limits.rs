//! The limits [`AlertRule::validate_custom`] and [`crate::AlertSettings::validate`]
//! enforce on custom rules, and the text of every [`AlertRuleError`], published as one
//! value so the client and the mock transport reject what Rust rejects and say it in
//! Rust's words.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::alert::{AlertRule, AlertRuleError, metric_message};
use crate::alert_metrics::{ALERT_METRICS, alert_metric};
use crate::catalog::Catalog;

/// What [`AlertRule::validate_custom`] and [`crate::AlertSettings::validate`] check, from
/// the constants and catalog the validation itself reads.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct AlertLimits {
    /// [`AlertRule::MAX_CUSTOM`].
    pub max_custom: u32,
    /// [`AlertRule::MAX_NAME_CHARS`].
    pub max_name_chars: u32,
    /// [`AlertRule::MAX_FOR_SECS`].
    pub max_for_secs: u32,
    /// [`AlertRule::MIN_COOLDOWN_SECS`].
    pub min_cooldown_secs: u32,
    /// [`AlertRule::MAX_COOLDOWN_SECS`].
    pub max_cooldown_secs: u32,
    /// Ids a custom rule may not use.
    pub builtin_ids: Vec<String>,
    /// The label key a rule on each alertable metric may select by; metrics with one
    /// unlabelled series are absent.
    pub label_keys: BTreeMap<&'static str, Vec<&'static str>>,
    /// Each [`AlertRuleError`]'s Display text by a stable key ("name", "metric",
    /// "labels", "value", "duration", "cooldown", "reserved_id", "not_threshold",
    /// "too_many", "duplicate_id"). The "metric" text holds the placeholder `{metric}`
    /// where the error names the metric id, quoted.
    pub messages: BTreeMap<&'static str, String>,
}

/// The label keys a rule on `metric` may select a series by: the catalog metric's
/// label keys, or none for a metric that is not alertable or carries no labels.
pub fn alert_label_keys(metric: &str) -> &'static [&'static str] {
    if alert_metric(metric).is_none() {
        return &[];
    }
    Catalog::builtin()
        .get(metric)
        .map_or(&[], |def| def.label_keys)
}

/// [`AlertLimits`] as the validation applies them.
pub fn alert_limits() -> AlertLimits {
    let label_keys = ALERT_METRICS
        .iter()
        .filter_map(|m| {
            let keys = alert_label_keys(m.metric);
            (!keys.is_empty()).then(|| (m.metric, keys.to_vec()))
        })
        .collect();
    AlertLimits {
        max_custom: u32::try_from(AlertRule::MAX_CUSTOM).unwrap_or(u32::MAX),
        max_name_chars: u32::try_from(AlertRule::MAX_NAME_CHARS).unwrap_or(u32::MAX),
        max_for_secs: AlertRule::MAX_FOR_SECS,
        min_cooldown_secs: AlertRule::MIN_COOLDOWN_SECS,
        max_cooldown_secs: AlertRule::MAX_COOLDOWN_SECS,
        builtin_ids: AlertRule::BUILTIN_IDS
            .iter()
            .map(ToString::to_string)
            .collect(),
        label_keys,
        messages: messages(),
    }
}

/// Every [`AlertRuleError`]'s text by its key. `Value`'s text does not depend on the
/// range it carries.
fn messages() -> BTreeMap<&'static str, String> {
    [
        ("name", AlertRuleError::Name.to_string()),
        ("metric", metric_message("{metric}")),
        ("labels", AlertRuleError::Labels.to_string()),
        (
            "value",
            AlertRuleError::Value { min: 0.0, max: 0.0 }.to_string(),
        ),
        ("duration", AlertRuleError::Duration.to_string()),
        ("cooldown", AlertRuleError::Cooldown.to_string()),
        ("reserved_id", AlertRuleError::ReservedId.to_string()),
        ("not_threshold", AlertRuleError::NotThreshold.to_string()),
        ("too_many", AlertRuleError::TooMany.to_string()),
        ("duplicate_id", AlertRuleError::DuplicateId.to_string()),
    ]
    .into_iter()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_metric_template_reads_as_the_error_once_the_id_is_filled_in() {
        let template = &alert_limits().messages["metric"];
        assert_eq!(
            template.replace("{metric}", "\"cpu.load\""),
            AlertRuleError::Metric("cpu.load".into()).to_string()
        );
    }

    #[test]
    fn label_keys_are_published_for_labelled_alertable_metrics_only() {
        assert_eq!(alert_label_keys("fan.rpm"), ["fan"]);
        assert!(alert_label_keys("mem.pressure").is_empty());
        assert!(alert_label_keys("cpu.load").is_empty());
        assert_eq!(
            alert_limits().label_keys,
            BTreeMap::from([("disk.free", vec!["vol"]), ("fan.rpm", vec!["fan"])])
        );
    }
}
