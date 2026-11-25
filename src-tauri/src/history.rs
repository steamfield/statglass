//! Shell history adapter. Store lifecycle/read pooling lives in statglass-engine;
//! query adapters and IPC conversion remain beside their command-facing owner.
use crate::error::{CommandError, HistoryUnavailableReason};
use crate::ipc::{
    ExportRequest, HeatmapDay, HeatmapMetric, HeatmapRequest, HistoryHealth, HistoryPage,
    HistoryRequest, NetworkByApp, NetworkSpan, ProcessResolution, ProcessesAt, StoredProcess,
};
use statglass_engine::{HistoryStore, HousekeepingHandle};
use statglass_schema::lock::LockExt;
use statglass_schema::{
    AlertSettings, Event, EventDetail, HostId, HostRecord, Labels, MetricId, SeriesKey, Tier,
    TimeRange,
};
use statglass_store::{
    BucketRow, ExportQuery, HistoryQuery, HistoryResult, ProcResolution, RangeStats, Reader,
    Retention, TierChoice, Writer,
};
use std::path::Path;
use std::sync::{Arc, Mutex};
mod ipc;
mod queries;
pub mod retry;
#[cfg(test)]
use crate::ipc::TierRequest;
#[cfg(test)]
use ipc::MAX_HEATMAP_DAYS;
#[cfg(test)]
mod tests;
pub use statglass_engine::HISTORY_DB_FILE as DB_FILE;
#[cfg(test)]
use statglass_store::{Store, StoreConfig};

pub(crate) const MAX_NET_SPAN_MS: i64 = {
    let days = statglass_schema::settings::HistorySettings::RETENTION_DAYS;
    days[days.len() - 1] as i64 * Retention::DAY_MS
};

pub struct History {
    storage: Arc<HistoryStore>,
    /// Held while sources are moved to a new or reopened store, so a reset and a retry
    /// never hand them writers in the wrong order.
    attaching: Mutex<()>,
}
impl History {
    pub fn open(dir: &Path) -> Self {
        Self {
            storage: Arc::new(HistoryStore::open(dir)),
            attaching: Mutex::default(),
        }
    }
    pub fn unavailable() -> Self {
        Self {
            storage: Arc::new(HistoryStore::unavailable()),
            attaching: Mutex::default(),
        }
    }
    /// Wraps a store already opened (`identity::open_local`).
    pub fn from_store(storage: HistoryStore) -> Self {
        Self {
            storage: Arc::new(storage),
            attaching: Mutex::default(),
        }
    }
    pub(super) fn store(&self) -> Arc<HistoryStore> {
        self.storage.clone()
    }
    pub fn register_host(&self, record: &HostRecord) -> Option<Writer> {
        self.storage.register_host(record)
    }
    pub fn health(&self) -> HistoryHealth {
        self.storage.health().into()
    }
    pub fn clear_trim(&self) -> Option<HistoryHealth> {
        self.storage.clear_trim().map(Into::into)
    }
    pub fn is_available(&self) -> bool {
        self.storage.is_available()
    }
    pub fn unavailable_reason(&self) -> Option<HistoryUnavailableReason> {
        self.storage.unavailable_reason()
    }
    pub fn writer(&self) -> Result<Writer, CommandError> {
        Ok(self.storage.writer()?)
    }
    pub fn read<T>(
        &self,
        f: impl FnOnce(&mut Reader) -> statglass_store::Result<T>,
    ) -> Result<T, CommandError> {
        Ok(self.storage.read(f)?)
    }
    pub fn size_on_disk(&self) -> Result<u64, CommandError> {
        Ok(self.storage.size_on_disk()?)
    }
    pub fn close(&self) {
        self.storage.close();
    }
    /// Opens the same file again after a failure that can clear up (a full disk, a lock
    /// another process held). `Ok(None)` when it is open already or the reason needs a
    /// reset instead.
    pub fn reopen(&self) -> Result<Option<Writer>, CommandError> {
        Ok(self.storage.reopen()?)
    }
    pub fn reset(&self, now_ms: i64) -> Result<Writer, CommandError> {
        Ok(self.storage.reset(now_ms)?)
    }
    /// The alert events of the last [`statglass_engine::detect::alert_history_ms`] for
    /// `alerts`, which the engine seeds its alert cooldowns from so a restart does not
    /// re-fire a rule. Empty when history is unavailable or the read fails: the rules then
    /// start with no cooldown. One small indexed query at launch.
    pub fn recent_alerts(&self, host: HostId, now: i64, alerts: &AlertSettings) -> Vec<Event> {
        if !self.is_available() {
            return Vec::new();
        }
        let from = now - statglass_engine::detect::alert_history_ms(alerts);
        match self.alerts_since(host, from, now) {
            Ok(events) => events,
            Err(e) => {
                tracing::warn!("reading recent alerts, alert cooldowns start fresh: {e:?}");
                Vec::new()
            }
        }
    }
    /// The alert events `host` recorded from `from_ms` through `now`. An error when
    /// history is unavailable or the read fails; callers check
    /// [`History::is_available`] first when the two need telling apart.
    pub fn alerts_since(
        &self,
        host: HostId,
        from_ms: i64,
        now: i64,
    ) -> Result<Vec<Event>, CommandError> {
        let events = self.read(|r| r.events(host, from_ms, now.saturating_add(1)))?;
        Ok(events
            .into_iter()
            .filter(|e| matches!(e.detail, EventDetail::Alert { .. }))
            .collect())
    }
    pub fn spawn_pruner(
        &self,
        retention: impl Fn() -> Retention + Send + 'static,
        on_change: impl Fn(HistoryHealth) + Send + 'static,
    ) -> std::io::Result<HousekeepingHandle> {
        self.storage
            .spawn_pruner(retention, move |health| on_change(health.into()))
    }
}

impl History {
    /// [`History::reset`], then `attach` (reattach every source, registering its host),
    /// then confirm the store is still there. Returns the health to announce; an error
    /// means history is unavailable and nothing should be announced, so a window's cached
    /// `history_unavailable` (and its banner) stays.
    pub fn reset_and_attach(
        &self,
        now_ms: i64,
        attach: impl FnOnce(&History),
    ) -> Result<HistoryHealth, CommandError> {
        let _attaching = self.attaching.lock_ok();
        self.reset(now_ms)?;
        attach(self);
        if !self.is_available() {
            return Err(self
                .writer()
                .err()
                .unwrap_or_else(CommandError::history_unavailable));
        }
        Ok(self.health())
    }

    /// [`History::reopen`], then `attach` when it opened. Returns the health to announce
    /// once history is back; `Ok(None)` when there was nothing to reopen.
    pub fn reopen_and_attach(
        &self,
        attach: impl FnOnce(&History),
    ) -> Result<Option<HistoryHealth>, CommandError> {
        let _attaching = self.attaching.lock_ok();
        if self.reopen()?.is_none() {
            return Ok(None);
        }
        attach(self);
        Ok(Some(self.health()))
    }
}
