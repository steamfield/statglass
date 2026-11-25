//! Transient history refresh, independent of wire detail demand.
use super::*;
use statglass_proto::{WireBucket, WireLayout};

/// How soon a session without a mirror asks again for the rows its ring is missing.
const RING_RETRY: Duration = Duration::from_secs(5);

impl Session<'_> {
    pub(super) async fn request_recent(&mut self) -> Result<()> {
        let (detail, recent) = {
            let control = self.control.borrow();
            (control.interest.detail, control.recent_interest)
        };
        let period = if recent && !detail { 15 } else { 30 };
        let due = if self.source.mirror.is_some() {
            (detail || recent) && self.last_recent.elapsed() >= Duration::from_secs(period)
        } else {
            // Without a mirror the snapshot only refills the live ring, once per stretch
            // of live detail; a failed request is tried again after a short pause.
            detail && !self.ring_filled && self.last_recent.elapsed() >= RING_RETRY
        };
        if self.history_available
            && due
            && self.in_flight.is_none()
            && !self.mirror_write.running()
            && !self.recent_pending
            && self.recent_timed_out.is_none()
            && self.next_tier >= self.tiers.len()
        {
            let now = self
                .source
                .clock
                .now_ms()
                .unwrap_or_else(statglass_engine::wall_ms);
            let from_ms = if !detail && recent {
                if let Some(mirror) = self.source.mirror.clone() {
                    let watermark = tokio::task::spawn_blocking(move || mirror.recent_watermark())
                        .await
                        .map_err(|e| RemoteError::Transport(e.to_string()))
                        .and_then(|result| {
                            result.map_err(|e| RemoteError::Transport(e.to_string()))
                        });
                    match watermark {
                        Ok(from) => from.unwrap_or_else(|| now.saturating_sub(300_000)),
                        Err(error) => {
                            self.watermark_failed = true;
                            self.status.history_error =
                                Some(format!("reading the mirror watermark: {error}"));
                            self.last_recent = Instant::now();
                            (self.source.on_status)(self.status.clone());
                            return Ok(());
                        }
                    }
                } else {
                    now.saturating_sub(300_000)
                }
            } else {
                now.saturating_sub(300_000)
            };
            let request_changed = {
                let control = self.control.borrow();
                control.network != self.network
                    || (control.interest.detail, control.recent_interest) != (detail, recent)
            };
            if request_changed {
                return Ok(());
            }
            if self.watermark_failed {
                self.watermark_failed = false;
                self.status.history_error = None;
                (self.source.on_status)(self.status.clone());
            }
            self.write(&Message::RecentRequest {
                from_ms,
                to_ms: now,
            })
            .await?;
            self.last_recent = Instant::now();
            self.recent_pending = true;
        }

        Ok(())
    }

    /// A recent snapshot goes to the mirror, or without one straight into the live ring.
    pub(super) fn recent_rows(
        &mut self,
        epoch: uuid::Uuid,
        tier: Tier,
        complete_to_ms: i64,
        layouts: Vec<WireLayout>,
        rows: Vec<WireBucket>,
    ) -> Result<()> {
        if self.recent_timed_out.take().is_some() {
            tracing::debug!("dropping late recent snapshot");
            return Ok(());
        }
        if !self.recent_pending {
            return Err(RemoteError::Transport("unsolicited recent snapshot".into()));
        }
        self.recent_pending = false;
        if epoch != self.epoch {
            return Err(RemoteError::Transport(
                "source history was reset; reconnecting".into(),
            ));
        }
        if let Some(mirror) = self.source.mirror.clone() {
            self.mirror_write.start(MirrorWork::Recent, move || {
                mirror.recent(epoch, tier, complete_to_ms, layouts, rows)
            });
        } else {
            self.refill_ring_from_recent(tier, complete_to_ms, layouts, rows);
        }
        Ok(())
    }

    /// A session without a mirror fills its live ring from the host's recent snapshot,
    /// so a window opened on a fresh connection shows the minutes before it. Runs once
    /// per stretch of live detail, like [`Self::refill_ring`]; a snapshot that fails
    /// validation is logged, not asked for again, and the ring keeps its live frames.
    fn refill_ring_from_recent(
        &mut self,
        tier: Tier,
        complete_to_ms: i64,
        layouts: Vec<WireLayout>,
        rows: Vec<WireBucket>,
    ) {
        if self.ring_filled || !self.control.borrow().interest.detail {
            return;
        }
        self.ring_filled = true;
        let host = self.source.record.id;
        let recent = match crate::recent_rows::recent_buckets(
            &statglass_schema::Catalog::builtin(),
            host,
            tier,
            complete_to_ms,
            layouts,
            rows,
        ) {
            Ok(recent) => recent,
            Err(error) => {
                tracing::warn!(%host, "refilling the live ring from recent rows: {error}");
                self.sync_refill_pending();
                return;
            }
        };
        let now = self
            .source
            .clock
            .now_ms()
            .unwrap_or_else(statglass_engine::wall_ms);
        let query = statglass_engine::ring_history_query(host, now);
        let history = match statglass_store::history_recent(&query, &recent.rows) {
            Ok(history) => history,
            Err(error) => {
                tracing::warn!(%host, "reading recent rows for the live ring: {error}");
                self.sync_refill_pending();
                return;
            }
        };
        let timeline = self.source.next_timeline.fetch_add(1, Ordering::Relaxed);
        let added = self.sink.live.refill(&history, timeline);
        if added > 0 {
            self.timeline = timeline;
            tracing::info!(%host, added, "live ring refilled from recent rows");
        }
        self.sync_refill_pending();
    }

    /// Tells open windows whether the ring still waits on a refill from the host's
    /// recent rows (D-159): a session without a mirror whose host keeps history, while
    /// live detail is on (the refill runs only then; cellular can withhold it), before
    /// its refill for this stretch of detail has run or its request has timed out.
    pub(super) fn sync_refill_pending(&self) {
        let pending = self.source.mirror.is_none()
            && self.detail
            && self.history_available
            && !self.ring_filled
            && self.recent_timed_out.is_none();
        self.sink.live.set_refill_pending(pending);
    }
}
