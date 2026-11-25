//! How a caller tunes the source's runtime, history sync and local network probe.
use super::{MirrorWork, RemoteSource, Session, adapt_page_bytes, quiesce::WriteResult};
use crate::network::LocalNetwork;
use crate::{MirrorSink, Result, network};
use statglass_proto::{Message, SyncRequest};
use statglass_schema::Tier;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// How long a session on a changed network waits for a Pong to its immediate Ping
/// before it is dropped as a dead route.
pub const NETWORK_CHANGE_PROBE: Duration = Duration::from_secs(5);

/// How much history a source syncs into its mirror. Live frames flow under every policy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SyncPolicy {
    /// Every tier the sink keeps.
    #[default]
    Full,
    /// Only the coarsest tier the sink keeps (a phone on cellular).
    SummaryOnly,
    /// No sync requests at all.
    Off,
}

/// A source's platform choices. `Default` is the desktop's.
#[derive(Clone, Default)]
pub struct SourceOptions {
    /// The runtime the source's task runs on; `None` runs it on its own thread, as today.
    pub runtime: Option<tokio::runtime::Handle>,
    /// How much history to sync.
    pub sync: SyncPolicy,
    /// Reads the local network; `None` uses [`crate::network::probe`].
    pub probe: Option<Arc<dyn Fn() -> LocalNetwork + Send + Sync>>,
}

impl RemoteSource {
    /// Changes how much history the source syncs without reconnecting.
    pub fn set_sync_policy(&self, policy: SyncPolicy) {
        self.control.send_if_modified(|state| {
            let changed = state.sync != policy;
            state.sync = policy;
            changed
        });
    }

    pub(super) fn probe_network(&self) -> Option<LocalNetwork> {
        self.options
            .probe
            .as_ref()
            .map_or_else(network::probe_snapshot, |probe| Some(probe()))
    }
}

impl SyncPolicy {
    pub(super) fn tiers(self, mirror: Option<&dyn MirrorSink>) -> &[Tier] {
        let tiers: &[Tier] =
            mirror.map_or(&[Tier::S10, Tier::M1, Tier::M15], MirrorSink::sync_tiers);
        match self {
            Self::Full => tiers,
            Self::SummaryOnly => tiers.last().map_or(&[], std::slice::from_ref),
            Self::Off => &[],
        }
    }
}

impl Session<'_> {
    pub(super) async fn request_sync(&mut self) -> Result<bool> {
        if self.mirror_write.running() {
            return Ok(false);
        }
        // No wire request IDs: never overlap requests for a tier awaiting a late reply.
        while self.next_tier < self.tiers.len()
            && self.timed_out.contains_key(&self.tiers[self.next_tier])
        {
            self.next_tier += 1;
        }
        if self.clock_ready
            && self.source.clock.now_ms().is_some()
            && self.history_available
            && !self.history_failed
            && !self.recent_pending
            && self.in_flight.is_none()
            && self.next_tier < self.tiers.len()
            && let Some(mirror) = &self.source.mirror
        {
            let tier = self.tiers[self.next_tier];
            let now = self
                .source
                .clock
                .now_ms()
                .unwrap_or_else(statglass_engine::wall_ms);
            let after = if self.restart_cursor.remove(&tier) {
                None
            } else {
                match mirror.cursor(tier, self.epoch, self.kinds) {
                    Ok(cursor) => {
                        self.mirror_epoch_ready = true;
                        cursor
                    }
                    Err(error) => {
                        self.history_failed = true;
                        self.watermark_failed = false;
                        self.status.history_error = Some(error.to_string());
                        self.status.catching_up = false;
                        (self.source.on_status)(self.status.clone());
                        return Ok(true);
                    }
                }
            };
            let floor = mirror
                .history_floor(tier, now)
                .max(self.floors.get(&tier).copied().unwrap_or(i64::MIN));
            self.write(&Message::SyncRequest(SyncRequest {
                tier,
                after,
                max_rows: 2000,
                from_ms: Some(floor),
                max_bytes: Some(self.page_bytes),
            }))
            .await?;
            self.in_flight = Some((tier, after, Instant::now()));
            self.status.catching_up = true;
            (self.source.on_status)(self.status.clone());
            if self.next_tier == 0 {
                self.last_sync = Instant::now();
            }
        }

        Ok(false)
    }

    pub(super) fn apply_sync_policy(&mut self) {
        let policy = self.control.borrow().sync;
        // A reply already on the wire still belongs to the previous tier list.
        if self.sync_policy != policy && self.in_flight.is_none() && !self.mirror_write.running() {
            self.sync_policy = policy;
            self.tiers = policy.tiers(self.source.mirror.as_deref());
            self.next_tier = 0;
            self.history_failed = false;
        }
    }

    pub(super) fn mirror_write_finished(&mut self, work: MirrorWork, result: WriteResult) {
        match work {
            MirrorWork::Page { more, requested } => {
                self.watermark_failed = false;
                if let Err(error) = result {
                    self.history_failed = true;
                    self.next_tier = self.tiers.len();
                    self.last_sync = Instant::now();
                    self.status.history_error = Some(error.to_string());
                    self.status.catching_up = false;
                    (self.source.on_status)(self.status.clone());
                } else {
                    self.status.history_error = None;
                    if !more {
                        self.next_tier += 1;
                    }
                }
                self.page_bytes = adapt_page_bytes(self.page_bytes, requested.elapsed());
            }
            MirrorWork::Prune => {
                if let Err(error) = result {
                    self.watermark_failed = false;
                    self.status.history_error = Some(error.to_string());
                }
                self.status.catching_up = false;
                (self.source.on_status)(self.status.clone());
            }
        }
    }
}
