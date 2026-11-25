//! Reading and setting a Linux agent host's alert rules from this Mac
//! (plan/rfc-remote-alerts.md 5.6): the two commands and their error mapping.

use serde::{Deserialize, Serialize};
use statglass_proto::{HostAlertRules, RuleEntry};
use statglass_schema::{AlertRule, HostId, JsSafeInt};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::error::CommandError;
use crate::state::AppState;

/// The agent's opaque rule revision crosses IPC as a JavaScript number.
#[derive(Deserialize, specta::Type)]
#[serde(transparent)]
pub struct RulesRevision(#[specta(type = JsSafeInt)] i64);

#[derive(Serialize, specta::Type)]
pub struct RemoteAlertRules {
    #[specta(type = JsSafeInt)]
    pub revision: i64,
    pub rules: Vec<AlertRule>,
    pub newer: Vec<NewerRule>,
}

#[derive(Serialize, specta::Type)]
pub struct NewerRule {
    pub id: Option<Uuid>,
}

impl From<HostAlertRules> for RemoteAlertRules {
    fn from(host_rules: HostAlertRules) -> Self {
        let mut rules = Vec::new();
        let mut newer = Vec::new();
        for entry in host_rules.rules {
            match entry {
                RuleEntry::Known(rule) => rules.push(rule),
                RuleEntry::Unknown(raw) => {
                    let id = raw.as_map().and_then(|fields| {
                        let (_, value) =
                            fields.iter().find(|(key, _)| key.as_text() == Some("id"))?;
                        value.deserialized::<Uuid>().ok().or_else(|| {
                            let text = value.deserialized::<String>().ok()?;
                            Uuid::parse_str(&text).ok()
                        })
                    });
                    newer.push(NewerRule { id });
                }
            }
        }
        Self {
            revision: host_rules.revision,
            rules,
            newer,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn remote_alert_rules(
    app: AppHandle,
    host: HostId,
) -> Result<RemoteAlertRules, CommandError> {
    let state = app.state::<AppState>();
    let source = state.remotes.alert_rules_source(state.local, host)?;
    let rules = source
        .alert_rules()
        .await
        .map_err(CommandError::from_alert_rules)?;
    Ok(rules.into())
}

#[tauri::command]
#[specta::specta]
pub async fn set_remote_alert_rules(
    app: AppHandle,
    host: HostId,
    base_revision: RulesRevision,
    rules: Vec<AlertRule>,
    keep: Vec<Uuid>,
) -> Result<RemoteAlertRules, CommandError> {
    let state = app.state::<AppState>();
    let source = state.remotes.alert_rules_source(state.local, host)?;
    replace_alert_rules(base_revision, rules, keep, async |revision, rules, keep| {
        source.set_alert_rules(revision, rules, keep).await
    })
    .await
}

pub(crate) async fn replace_alert_rules(
    base_revision: RulesRevision,
    rules: Vec<AlertRule>,
    keep: Vec<Uuid>,
    send: impl AsyncFnOnce(i64, Vec<RuleEntry>, Vec<Uuid>) -> statglass_remote::Result<HostAlertRules>,
) -> Result<RemoteAlertRules, CommandError> {
    let rules = rules.into_iter().map(RuleEntry::Known).collect();
    let applied = send(base_revision.0, rules, keep)
        .await
        .map_err(CommandError::from_alert_rules)?;
    Ok(applied.into())
}
