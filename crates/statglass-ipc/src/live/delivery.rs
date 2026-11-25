//! Delivers bus messages while the window is visible.
use super::*;
use crate::process::LiveProcess;
use statglass_engine::{BusMsg, ProcessSample, Recv, Subscriber};

impl Stream {
    fn on_processes(&mut self, ts_ms: i64, rows: &[ProcessSample]) -> Result<(), Closed> {
        if self.display_idle {
            return Ok(());
        }
        let picked = {
            let view = self.procs.lock_ok();
            let Some(view) = view.as_ref() else {
                return Ok(());
            };
            if let (Some(period), Some(last)) = (view.period_ms, self.last_procs_ts) {
                // A tenth of slack so jittered ticks do not skip a whole period.
                if (ts_ms - last) * 10 < i64::from(period) * 9 {
                    return Ok(());
                }
            }
            let rule = self.refusals.as_ref().map(|source| source.batch());
            let no_refusal = |_, _, _: &str| None;
            LiveProcess::select(rows, view, rule.as_deref().unwrap_or(&no_refusal))
        };
        self.last_procs_ts = Some(ts_ms);
        self.send(LiveMsg::Processes {
            ts_ms,
            rows: picked,
        })
    }

    fn on_msg(&mut self, msg: BusMsg) -> Result<(), Closed> {
        match msg {
            BusMsg::Frame(f) => self.on_frame(&f)?,
            // Frames carry their layout; it is sent with the first frame that uses it.
            BusMsg::Layout(_) => {}
            BusMsg::Caps(c) => self.send_caps((*c).clone())?,
            BusMsg::Status(s) => {
                let was_idle = self.display_idle;
                self.send_status(&s)?;
                if was_idle && !self.display_idle {
                    self.catch_up()?;
                }
            }
            BusMsg::Processes(p) => self.on_processes(p.ts_ms, &p.rows)?,
            // Each app delivers events through its own event path. The desktop sends
            // the `event-recorded` Tauri event from `src-tauri/src/state.rs`.
            BusMsg::Event(_) => {}
        }
        Ok(())
    }

    /// Runs until the receiver is gone, the window closes, or the bus closes. While the
    /// window is hidden it holds no bus subscriber, so it costs nothing per tick.
    pub(super) async fn run(
        mut self,
        mut visible: watch::Receiver<bool>,
        mut sub: Option<Subscriber>,
    ) {
        loop {
            let Some(s) = sub.as_mut() else {
                // Hidden: drain promised history regardless of display_idle, so charts
                // are not left loading until the next show (D-133).
                while !self.earlier.is_empty() {
                    if self.send_earlier().is_err() {
                        return;
                    }
                }
                if visible.wait_for(|v| *v).await.is_err() {
                    return;
                }
                let s = self.feed.hub().subscribe();
                if self.catch_up().is_err() {
                    return;
                }
                sub = Some(s);
                continue;
            };
            let pending = !self.earlier.is_empty() && !self.display_idle;
            let go = self.earlier_go;
            let earlier_at = self.earlier_at;
            tokio::select! {
                // The bus first: a frame is never queued behind old history.
                biased;
                ev = s.recv_event() => match ev {
                    // Hidden since this was published (the bus goes first), or hidden
                    // and shown again before this task ran: stop here. The resume's
                    // catch-up sends what was missed with the status in effect then,
                    // not the background tick hiding put in (D-094).
                    Recv::Msg(_) if !*visible.borrow() || visible.has_changed().unwrap_or(true) => {
                        tracing::debug!(host = %self.feed.host(), "live channel stopped");
                        sub = None;
                    }
                    Recv::Msg(m) => {
                        if self.on_msg(m).is_err() {
                            return;
                        }
                    }
                    Recv::Lagged(n) => {
                        // The hub's ring has what the bus dropped.
                        tracing::debug!(host = %self.feed.host(), lost = n, "live channel lagged");
                        if self.catch_up().is_err() {
                            return;
                        }
                    }
                    Recv::Closed => return,
                },
                changed = visible.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    if !*visible.borrow_and_update() {
                        tracing::debug!(host = %self.feed.host(), "live channel stopped");
                        sub = None;
                    }
                }
                () = tokio::time::sleep_until(earlier_at), if pending && !go => {
                    self.earlier_go = true;
                }
                () = std::future::ready(()), if pending && go => {
                    if self.send_earlier().is_err() {
                        return;
                    }
                }
            }
        }
    }
}
