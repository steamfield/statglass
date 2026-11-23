//! The alerts part of a settings patch, and which rules a change switched on.

use std::collections::HashSet;

use super::set;
use serde::Deserialize;
use statglass_schema::settings::AlertSettings;
use statglass_schema::{AlertRule, Settings};
use uuid::Uuid;

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

/// What a settings change switched on: the moment to ask for notification permission
/// and post the confirmation that makes macOS show its prompt (D-084).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SwitchedOn {
    /// The rules, built-in or custom, enabled in `new` and not enabled in `old` (switched
    /// on, or added already on). A rule edited while it stays on is not listed.
    pub rules: Vec<AlertRule>,
    /// The host-offline alert went from off to on.
    pub host_offline: bool,
}

impl SwitchedOn {
    /// Nothing was switched on.
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty() && !self.host_offline
    }
}

/// What the change from `old` to `new` switched on.
pub fn alerts_switched_on(old: &Settings, new: &Settings) -> SwitchedOn {
    let enabled_before: HashSet<Uuid> = old
        .alerts
        .engine_rules()
        .into_iter()
        .filter(|rule| rule.enabled)
        .map(|rule| rule.id)
        .collect();
    let rules = new
        .alerts
        .engine_rules()
        .into_iter()
        .filter(|rule| rule.enabled && !enabled_before.contains(&rule.id))
        .collect();
    SwitchedOn {
        rules,
        host_offline: new.alerts.host_offline && !old.alerts.host_offline,
    }
}
