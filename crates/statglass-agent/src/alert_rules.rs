//! The agent's running custom rules and the revision controllers edit against.
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::json;
use statglass_proto::{Answer, ErrorCode, HostAlertRules, RuleEntry};
use statglass_schema::lock::LockExt;
use statglass_schema::settings::AlertSettings;
use statglass_schema::{AlertRule, Settings};
use uuid::Uuid;

/// FNV-1a over the ordered JSON list, limited to a JavaScript-safe integer.
pub fn rules_revision(rules: &[AlertRule]) -> i64 {
    let bytes = serde_json::to_vec(rules).expect("alert rules serialize to JSON into a Vec");
    let hash = bytes
        .into_iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
    i64::try_from(hash & ((1 << 53) - 1)).expect("53 bits fit in i64")
}

pub struct AlertRuleStore {
    data_dir: PathBuf,
    settings: Mutex<Settings>,
}

impl AlertRuleStore {
    pub fn new(data_dir: PathBuf, settings: Settings) -> Self {
        Self {
            data_dir,
            settings: Mutex::new(settings),
        }
    }

    pub fn current(&self) -> HostAlertRules {
        answer_rules(&self.settings.lock_ok().alerts.rules)
    }

    /// Read and enqueue cooldowns under the same lock that orders rule changes.
    pub fn with_alerts(&self, seed: impl FnOnce(&AlertSettings)) {
        seed(&self.settings.lock_ok().alerts);
    }

    pub fn replace(
        &self,
        base_revision: i64,
        rules: Vec<RuleEntry>,
        keep: Vec<Uuid>,
        apply: impl FnOnce(&Settings),
    ) -> Answer {
        let mut settings = self.settings.lock_ok();
        if base_revision != rules_revision(&settings.alerts.rules) {
            return Answer::Error {
                code: ErrorCode::Stale,
                message: "The alert rules on this host changed. Reload them and try again.".into(),
            };
        }

        let mut next = Vec::with_capacity(rules.len());
        for entry in rules {
            let RuleEntry::Known(rule) = entry else {
                return Answer::Error {
                    code: ErrorCode::InvalidArgument,
                    message: "This agent does not know one of these rules. Update the agent."
                        .into(),
                };
            };
            next.push(rule);
        }
        next.extend(
            settings
                .alerts
                .rules
                .iter()
                .filter(|r| keep.contains(&r.id))
                .cloned(),
        );
        let alerts = AlertSettings {
            rules: next,
            ..settings.alerts
        };
        if let Err(e) = alerts.validate() {
            return Answer::Error {
                code: ErrorCode::InvalidArgument,
                message: e.to_string(),
            };
        }

        let patch = json!({ "alerts": { "rules": alerts.rules } }).to_string();
        if let Err(e) = crate::settings::configure(&self.data_dir, &patch) {
            return Answer::Error {
                code: ErrorCode::Internal,
                message: format!("Saving the alert rules: {e:#}"),
            };
        }
        // The file may also contain CLI edits that take effect on restart.
        settings.alerts.rules = alerts.rules;
        apply(&settings);
        Answer::AlertRules(answer_rules(&settings.alerts.rules))
    }
}

fn answer_rules(rules: &[AlertRule]) -> HostAlertRules {
    HostAlertRules {
        revision: rules_revision(rules),
        rules: rules.iter().cloned().map(RuleEntry::Known).collect(),
    }
}

#[cfg(test)]
#[path = "alert_rules_tests.rs"]
mod tests;
