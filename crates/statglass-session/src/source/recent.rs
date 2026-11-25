//! Transient history refresh, independent of wire detail demand.
use super::*;

impl Session<'_> {
    pub(super) fn recent_first(&self) -> bool {
        self.source
            .mirror
            .as_ref()
            .is_some_and(|mirror| mirror.recent_first())
    }

    async fn prepare_recent_epoch(&mut self) -> Result<quiesce::WriteResult> {
        if !self.mirror_epoch_ready
            && let Some(mirror) = self.source.mirror.clone()
        {
            // The mirror accepts recent rows only after it has seen this database epoch.
            let tier = mirror.sync_tiers().first().copied().unwrap_or(Tier::S10);
            let (epoch, kinds) = (self.epoch, self.kinds);
            let result = self
                .mirror_write
                .read(move || mirror.cursor(tier, epoch, kinds).map(|_| ()))
                .await?;
            self.mirror_epoch_ready = result.is_ok();
            return Ok(result);
        }
        Ok(Ok(()))
    }

    pub(super) async fn request_recent(&mut self) -> Result<()> {
        let (detail, recent) = {
            let control = self.control.borrow();
            (control.interest.detail, control.recent_interest)
        };
        let period = if recent && !detail { 15 } else { 30 };
        let recent_first = self.recent_first();
        if self.history_available
            && (detail || recent)
            && (!recent_first || self.clock_ready)
            && (self.recent_due || self.last_recent.elapsed() >= Duration::from_secs(period))
            && self.in_flight.is_none()
            && !self.mirror_write.running()
            && !self.recent_pending
            && self.recent_timed_out.is_none()
            && (recent_first || self.next_tier >= self.tiers.len())
        {
            if recent_first && let Err(error) = self.prepare_recent_epoch().await? {
                self.recent_due = false;
                self.watermark_failed = true;
                self.status.history_error = Some(format!(
                    "reading the mirror cursor for recent history: {error}"
                ));
                self.last_recent = Instant::now();
                (self.source.on_status)(self.status.clone());
                return Ok(());
            }
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
                            self.recent_due = false;
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
            self.recent_due = false;
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
}
