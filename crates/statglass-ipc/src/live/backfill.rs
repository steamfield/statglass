//! Initial and resumed ring backfill, plus delivery of older chunks.
use super::*;

/// Splits `seg` at `at_ms`: rows before it, rows at or after it.
fn split_segment(
    seg: BackfillSegment,
    at_ms: i64,
) -> (Option<BackfillSegment>, Option<BackfillSegment>) {
    let interval = i64::from(seg.interval_ms.max(1));
    let before = usize::try_from((at_ms - seg.start_ms + interval - 1).div_euclid(interval))
        .unwrap_or(0)
        .min(seg.rows.len());
    if before == 0 {
        return (None, Some(seg));
    }
    if before == seg.rows.len() {
        return (Some(seg), None);
    }
    let mut head = seg;
    let tail_rows = head.rows.split_off(before);
    let tail = BackfillSegment {
        layout: Arc::clone(&head.layout),
        start_ms: head.start_ms + len_i64(before) * interval,
        interval_ms: head.interval_ms,
        timeline: head.timeline,
        rows: tail_rows,
        holds: Arc::clone(&head.holds),
    };
    (Some(head), Some(tail))
}

/// `seg` in pieces of at most [`EARLIER_CHUNK_ROWS`] rows, oldest first.
fn chunks(seg: BackfillSegment) -> Vec<BackfillSegment> {
    let mut out = Vec::with_capacity(seg.rows.len() / EARLIER_CHUNK_ROWS + 1);
    let mut rest = Some(seg);
    while let Some(seg) = rest.take() {
        let at = seg.start_ms + len_i64(EARLIER_CHUNK_ROWS) * i64::from(seg.interval_ms.max(1));
        let (head, tail) = split_segment(seg, at);
        out.extend(head);
        rest = tail;
    }
    out
}

impl Stream {
    fn send_plan(&self, segs: &[BackfillSegment], earlier: Option<i64>) -> Result<(), Closed> {
        let recent_rows = segs
            .iter()
            .fold(0_u32, |n, s| n.saturating_add(len_u32(s.rows.len())));
        self.send(LiveMsg::BackfillPlan {
            recent_rows,
            earlier_start_ms: earlier,
        })
    }

    /// Sends one segment as `Backfill` (after its layout) and records it as sent.
    fn send_segment(&mut self, seg: &BackfillSegment) -> Result<(), Closed> {
        let Some(n) = seg.rows.len().checked_sub(1) else {
            return Ok(());
        };
        self.send_layout(&seg.layout)?;
        let pick = self.pick(&seg.layout);
        self.send(LiveMsg::Backfill {
            layout_no: seg.layout.layout_no,
            start_ms: seg.start_ms,
            interval_ms: seg.interval_ms,
            timeline: seg.timeline,
            rows: seg.rows.iter().map(|r| pick_values(&pick, r)).collect(),
            holds_ms: pick_holds(&pick, &seg.holds),
        })?;
        let interval = i64::from(seg.interval_ms);
        let last = seg.start_ms + len_i64(n) * interval;
        self.last_ts = Some(last);
        self.timeline = Some(seg.timeline);
        // Stored buckets are stamped at their exact end, not nominal tick times.
        // Their 10 s interval must not suppress the first 5 s of live frames.
        self.sent_until = if seg.layout.layout_no == statglass_engine::WARM_LAYOUT_NO {
            last
        } else {
            last + interval / 2
        };
        Ok(())
    }

    /// Sends what the window does not have yet: capabilities and status if they changed,
    /// then the ring rows since the last thing sent (at most `backfill_ms` back from the
    /// host's latest frame), in time order and in chunks. On a fresh stream only the last
    /// [`RECENT_MS`] go now; the rest is queued as `BackfillEarlier` chunks.
    ///
    /// If the source's clock stepped since the last thing sent (a new timeline, or "now"
    /// is before it), the stream starts over and sends from the first row not on the
    /// window's timeline, which is where the window has to drop what it holds.
    pub(super) fn catch_up(&mut self) -> Result<CatchUp, Closed> {
        self.send_caps(self.feed.capabilities())?;
        let status = self.feed.status();
        self.send_status(&status)?;

        let mut out = CatchUp::default();
        let feed = Arc::clone(&self.feed);
        let hub = feed.hub();
        // "Now" on the source's clock: the latest frame, or warm history
        // before the first frame (D-066, D-097).
        let Some((anchor, timeline)) = hub.backfill_anchor() else {
            return Ok(out);
        };
        let mut since = anchor - self.backfill_ms;
        let mut stepped_from = None;
        if let Some(last) = self.last_ts {
            if anchor < last || self.timeline.is_some_and(|t| t != timeline) {
                stepped_from = Some(self.timeline);
                self.restart_timeline();
            } else {
                since = since.max(last + 1);
            }
        }
        let mut segs = hub.backfill(since);
        if let Some(held) = stepped_from {
            let first = segs
                .iter()
                .position(|s| Some(s.timeline) != held)
                .unwrap_or(0);
            segs.drain(..first);
        }
        if stepped_from.is_some() || self.last_ts.is_some() {
            if stepped_from.is_some() {
                self.send_plan(&segs, None)?;
            }
            for seg in segs.into_iter().flat_map(chunks) {
                out.first.get_or_insert(seg.start_ms);
                out.rows = out.rows.saturating_add(len_u32(seg.rows.len()));
                self.send_segment(&seg)?;
            }
            return Ok(out);
        }

        let split = anchor - RECENT_MS;
        let mut recent = Vec::new();
        let mut earlier = Vec::new();
        for seg in segs {
            let (old, new) = split_segment(seg, split);
            earlier.extend(old);
            recent.extend(new);
        }
        // Every layout the older chunks use is announced first, so the last `Layout`
        // before the frames is the current one.
        for seg in &earlier {
            self.send_layout(&seg.layout)?;
        }
        out.earlier_start = earlier.first().map(|s| s.start_ms);
        self.send_plan(&recent, out.earlier_start)?;
        for seg in &recent {
            out.first.get_or_insert(seg.start_ms);
            out.rows = out.rows.saturating_add(len_u32(seg.rows.len()));
            self.send_segment(seg)?;
        }
        for seg in earlier {
            out.earlier_rows = out.earlier_rows.saturating_add(len_u32(seg.rows.len()));
            self.earlier.extend(chunks(seg));
        }
        // Newest first: each chunk is then older than everything sent before it.
        self.earlier.make_contiguous().reverse();
        if !self.earlier.is_empty() {
            self.earlier_go = false;
            self.earlier_at = Instant::now() + EARLIER_AFTER;
        }
        Ok(out)
    }

    pub(super) fn send_earlier(&mut self) -> Result<(), Closed> {
        let Some(seg) = self.earlier.pop_front() else {
            return Ok(());
        };
        let pick = self.pick(&seg.layout);
        self.send(LiveMsg::BackfillEarlier {
            layout_no: seg.layout.layout_no,
            start_ms: seg.start_ms,
            interval_ms: seg.interval_ms,
            rows: seg.rows.iter().map(|r| pick_values(&pick, r)).collect(),
            holds_ms: pick_holds(&pick, &seg.holds),
        })
    }
}
