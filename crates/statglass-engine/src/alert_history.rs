//! Reading back stored alert events, which a starting engine seeds its alert cooldowns
//! from so a restart does not re-fire a rule. The app and the headless agent both seed
//! through [`HistoryStore::recent_alerts`].

use statglass_schema::settings::AlertSettings;
use statglass_schema::{Event, EventDetail, HostId};

use crate::history_store::{HistoryStore, HistoryStoreError};

impl HistoryStore {
    /// The alert events of the last [`crate::detect::alert_history_ms`] for `alerts`.
    /// Empty when history is unavailable or the read fails: the rules then start with no
    /// cooldown. One small indexed query.
    pub fn recent_alerts(&self, host: HostId, now: i64, alerts: &AlertSettings) -> Vec<Event> {
        if !self.is_available() {
            return Vec::new();
        }
        let from = now - crate::detect::alert_history_ms(alerts);
        match self.alerts_since(host, from, now) {
            Ok(events) => events,
            Err(e) => {
                tracing::warn!("reading recent alerts, alert cooldowns start fresh: {e:?}");
                Vec::new()
            }
        }
    }

    /// The alert events `host` recorded from `from_ms` through `now`.
    ///
    /// # Errors
    ///
    /// When history is unavailable or the read fails; callers check
    /// [`HistoryStore::is_available`] first when the two need telling apart.
    pub fn alerts_since(
        &self,
        host: HostId,
        from_ms: i64,
        now: i64,
    ) -> Result<Vec<Event>, HistoryStoreError> {
        let events = self.read(|r| r.events(host, from_ms, now.saturating_add(1)))?;
        Ok(events
            .into_iter()
            .filter(|e| matches!(e.detail, EventDetail::Alert { .. }))
            .collect())
    }
}
