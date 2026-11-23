//! The alerts part of a settings patch, and which rules a change switched on.

use super::set;
use serde::Deserialize;
use statglass_schema::settings::AlertSettings;
use statglass_schema::{AlertRule, Settings};

/// A partial change to [`AlertSettings`]. `rules`, when present, replaces the whole
/// custom rule list; the patch path validates the result before anything is saved.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, specta::Type)]
#[serde(default)]
pub struct AlertsPatch {
    #[specta(optional)]
    pub hot_process: Option<bool>,
    #[specta(optional)]
    pub thermal_serious: Option<bool>,
    #[specta(optional)]
    pub host_offline: Option<bool>,
    #[specta(optional)]
    pub rules: Option<Vec<AlertRule>>,
}

impl AlertsPatch {
    /// Applies the patch to `alerts`: each switch present is set, and `rules`, when
    /// present, replaces the custom rules.
    pub fn apply(self, alerts: &mut AlertSettings) {
        set(&mut alerts.hot_process, self.hot_process);
        set(&mut alerts.thermal_serious, self.thermal_serious);
        set(&mut alerts.host_offline, self.host_offline);
        set(&mut alerts.rules, self.rules);
    }
}

/// The rules, built-in or custom, enabled in `new` and not enabled in `old` (switched
/// on, or added already on): the moment to ask for notification permission and post the
/// confirmation that makes macOS show its prompt (D-084). A rule edited while it stays
/// on is not listed.
pub fn alerts_switched_on(old: &Settings, new: &Settings) -> Vec<AlertRule> {
    let was_enabled = old.alerts.engine_rules();
    new.alerts
        .engine_rules()
        .into_iter()
        .filter(|now| now.enabled)
        .filter(|now| {
            !was_enabled
                .iter()
                .any(|was| was.id == now.id && was.enabled)
        })
        .collect()
}
