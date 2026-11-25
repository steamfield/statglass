//! Source runtime options, network probing and mirror sync.
use super::{MirrorWork, RemoteSource, Session, adapt_page_bytes, quiesce::WriteResult};
use crate::network::LocalNetwork;
use crate::{Result, network};
use statglass_proto::{Message, SyncRequest};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// How long a session on a changed network waits for a Pong to its immediate Ping
/// before it is dropped as a dead route.
pub const NETWORK_CHANGE_PROBE: Duration = Duration::from_secs(5);

/// A source's platform choices. `Default` is the desktop's.
#[derive(Clone, Default)]
pub struct SourceOptions {
    /// The runtime the source's task runs on; `None` runs it on its own thread, as today.
    pub runtime: Option<tokio::runtime::Handle>,
    /// Reads the local network; `None` uses [`crate::network::probe`].
    pub probe: Option<Arc<dyn Fn() -> LocalNetwork + Send + Sync>>,
}

impl RemoteSource {
    pub(super) fn probe_network(&self) -> Option<LocalNetwork> {
        self.options
            .probe
            .as_ref()
            .map_or_else(network::probe_snapshot, |probe| Some(probe()))
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
            && let Some(mirror) = self.source.mirror.clone()
        {
            let tier = self.tiers[self.next_tier];
            let now = self
                .source
                .clock
                .now_ms()
                .unwrap_or_else(statglass_engine::wall_ms);
            let restart = self.restart_cursor.contains(&tier);
            let (epoch, kinds) = (self.epoch, self.kinds);
            let request = self
                .mirror_write
                .read(move || {
                    let after = if restart {
                        None
                    } else {
                        mirror.cursor(tier, epoch, kinds)?
                    };
                    Ok((after, mirror.history_floor(tier, now)))
                })
                .await?;
            let (after, floor) = match request {
                Ok(request) => request,
                Err(error) => {
                    self.history_failed = true;
                    self.watermark_failed = false;
                    self.status.history_error = Some(error.to_string());
                    self.status.catching_up = false;
                    (self.source.on_status)(self.status.clone());
                    return Ok(true);
                }
            };
            if self.control.has_changed().unwrap_or(false) {
                return Ok(true);
            }
            let floor = floor.max(self.floors.get(&tier).copied().unwrap_or(i64::MIN));
            self.write(&Message::SyncRequest(SyncRequest {
                tier,
                after,
                max_rows: 2000,
                from_ms: Some(floor),
                max_bytes: Some(self.page_bytes),
            }))
            .await?;
            self.restart_cursor.remove(&tier);
            self.in_flight = Some((tier, after, Instant::now()));
            self.status.catching_up = true;
            (self.source.on_status)(self.status.clone());
            if self.next_tier == 0 {
                self.last_sync = Instant::now();
            }
        }

        Ok(false)
    }

    pub(super) async fn mirror_write_finished(
        &mut self,
        work: MirrorWork,
        result: WriteResult,
    ) -> Result<()> {
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
            MirrorWork::Recent => {
                if let Err(error) = result {
                    self.watermark_failed = false;
                    self.status.history_error = Some(error.to_string());
                } else if !self.ring_filled
                    && self.control.borrow().interest.detail
                    && let Some(mirror) = self.source.mirror.clone()
                {
                    self.refill_ring(mirror).await?;
                }
            }
            MirrorWork::Truncated => {
                if let Err(error) = result {
                    self.history_failed = true;
                    self.watermark_failed = false;
                    self.status.history_error = Some(error.to_string());
                }
            }
            MirrorWork::Read => {}
        }
        Ok(())
    }
}
