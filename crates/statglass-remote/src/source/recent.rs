//! Transient history refresh, independent of wire detail demand.
use super::*;

impl Session<'_> {
    pub(super) async fn request_recent(&mut self) -> Result<()> {
        let (detail, recent) = {
            let control = self.control.borrow();
            (control.interest.detail, control.recent_interest)
        };
        let period = if recent && !detail { 15 } else { 30 };
        if self.history_available
            && (detail || recent)
            && self.last_recent.elapsed() >= Duration::from_secs(period)
            && self.in_flight.is_none()
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
                        Ok(from) => {
                            if self.watermark_failed {
                                self.watermark_failed = false;
                                self.status.history_error = None;
                                (self.source.on_status)(self.status.clone());
                            }
                            from.unwrap_or_else(|| now.saturating_sub(300_000))
                        }
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
            codec::write(
                &mut self.writer,
                &Message::RecentRequest {
                    from_ms,
                    to_ms: now,
                },
            )
            .await?;
            self.last_recent = Instant::now();
            self.recent_pending = true;
        }

        Ok(())
    }
}
