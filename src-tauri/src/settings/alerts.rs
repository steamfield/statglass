//! The alerts part of a settings patch, and which rules a change switched on.

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
        if let Some(v) = self.hot_process {
            alerts.hot_process = v;
        }
        if let Some(v) = self.thermal_serious {
            alerts.thermal_serious = v;
        }
        if let Some(v) = self.host_offline {
            alerts.host_offline = v;
        }
    }
}

/// The rules, built-in or custom, enabled in `new` and not enabled in `old` (switched
/// on, or added already on): the moment to ask for notification permission and post the
/// confirmation that makes macOS show its prompt (D-084). A rule edited while it stays
/// on is not listed.
pub fn alerts_switched_on(old: &Settings, new: &Settings) -> Vec<AlertRule> {
    old.alerts
        .builtin_rules()
        .into_iter()
        .zip(new.alerts.builtin_rules())
        .filter(|(was, now)| !was.enabled && now.enabled)
        .map(|(_, now)| now)
        .collect()
}
