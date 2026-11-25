//! Live channels: one per (window label, host), owned and driven by Rust (architecture.md,
//! Window and channel lifecycle; infra 8; D-049, D-066).
//!
//! A window asks for a stream with `subscribe_live`, passing a `Channel<LiveMsg>` and,
//! optionally, the series it draws and how often it wants frames. Rust keeps the stream
//! here and decides when it runs. Hidden WKWebView timers are throttled, so a webview
//! cannot be trusted to notice it is hidden; the window code calls
//! [`LiveRegistry::window_visible`] instead, and the stream stops receiving from the bus
//! until the window is visible again. It then resumes with a backfill of exactly the span
//! it missed. Display sleep and screen lock (`EngineStatus::display_idle`) pause the frames
//! the same way, and so does falling behind the bus. A window the registry has not been
//! told is visible is hidden. The resume sends the missed span in time order, in
//! segments of at most [`EARLIER_CHUNK_ROWS`], one message each: an hour hidden is six
//! messages the webview applies one task at a time, not one long task.
//!
//! A stepped wall clock (D-064) shows as a new `timeline` on the source's frames. A
//! stream that sees one starts its timeline over and sends the new timeline from its
//! first row, so the window drops what it held from that time on.
//!
//! A fresh subscription sends the last two minutes of the host's ring before
//! `subscribe_live` returns and the older history afterwards, in chunks, newest first, so
//! the first paint never waits for an hour of rows. Everything is projected to the
//! window's series before it is serialized.
//!
//! Process interest is a per-window [`ProcessView`] (how many rows, ranked by what, how
//! often), tied to the page load that asked for it through the stream id. It counts only
//! while the window is visible, and the registry tells each host the shortest period any
//! visible window wants, which is how often its collector runs. Which rows a view gets is
//! [`statglass_engine::select_processes`], on the engine's view the window sent.
//!
//! Detail interest works the same way without being asked for: a visible window with a
//! live stream for a host counts once toward that engine's detail interest, which samples
//! IOReport every tick instead of every 10 s (D-061).
//!
//! The registry is generic over [`LiveFeed`] (one host's hub and controls) and
//! [`LiveSink`] (the window's channel), so tests drive it without Tauri or an engine.
//! Streams are tokio tasks: call [`LiveRegistry::subscribe`] from inside the runtime
//! (the async `subscribe_live` command does).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use statglass_engine::{
    BackfillSegment, EngineStatus, FrameLayout, LiveFrame, LiveHub, ProcessView,
};
use statglass_schema::lock::LockExt;
use statglass_schema::{
    Capabilities, Catalog, HostId, MetricKind, PerformanceReason, SeriesSelector,
};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::process::RefusalSource;

mod contracts;
pub use contracts::{LiveMsg, LiveStatus, SubscriptionInfo};

/// One host's live data, as a stream needs it.
pub trait LiveFeed: Send + Sync + 'static {
    fn host(&self) -> HostId;
    /// Only this Mac's display can suspend delivery to its windows. A remote
    /// host's locked or sleeping display does not stop its live samples.
    fn is_local(&self) -> bool {
        true
    }
    /// The host's hub: bus, ring buffer, latest frame and status. Times in it are on the
    /// source's clock, so a remote host's backfill window is measured on its own clock.
    fn hub(&self) -> &LiveHub;
    fn capabilities(&self) -> Capabilities;
    /// The latest status the source published.
    fn status(&self) -> EngineStatus {
        self.hub().status()
    }
    /// A feed may deliver less often than its engine samples.
    fn min_frame_period_ms(&self) -> u32 {
        0
    }
    /// The shortest period any visible window wants process rows at (`None`: none does).
    fn set_process_interest(&self, period_ms: Option<u32>);
    /// Whether any visible window with process interest shows network rates (D-081).
    fn set_network_process_interest(&self, interested: bool);
    /// Whether any visible window with process interest shows GPU time.
    fn set_gpu_process_interest(&self, interested: bool);
    fn set_port_process_interest(&self, interested: bool);
    /// Whether any visible window needs detail from this source.
    fn set_detail_interest(&self, interested: bool);
}

/// Where a stream's messages go: the window's `Channel<LiveMsg>` in the app.
pub trait LiveSink: Send + Sync + 'static {
    /// `false` when the receiver is gone; the stream then ends.
    fn send(&self, msg: LiveMsg) -> bool;
    /// Identifies the page load that subscribed (the channel id).
    fn id(&self) -> u32;
}

/// The default backfill span when the window does not ask for one (the popover's 60 s
/// charts).
pub const DEFAULT_BACKFILL_MS: i64 = 60_000;

/// Upper bound on the backfill a window can ask for: the ring's span.
pub const MAX_BACKFILL_MS: i64 = statglass_engine::RING_SPAN_MS;

/// History a fresh subscription sends before `subscribe_live` returns; the rest follows
/// as `BackfillEarlier` chunks.
pub const RECENT_MS: i64 = 120_000;

/// Rows per `BackfillEarlier` chunk and per resume `Backfill` message (10 minutes at
/// 1 s).
pub const EARLIER_CHUNK_ROWS: usize = 600;

/// How long a window waits for a pending refill (D-159) before it shows what the ring
/// holds. A refill normally lands within a few seconds; one that never comes (live
/// detail withheld, or the screen left before it asked) must not hold a chart empty.
pub const REFILL_WAIT_MS: i64 = 10_000;

/// Older history starts after the first frame, or this long after the stream started if
/// no frame comes (paused, or a slow interval).
pub const EARLIER_AFTER: Duration = Duration::from_secs(1);

/// What a window asks of its stream.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveRequest {
    /// How much ring history to send first, ms (clamped to the ring's span).
    pub backfill_ms: i64,
    /// Only these series (`None`: every series in the layout).
    pub series: Option<Vec<SeriesSelector>>,
    /// At most one frame per this many ms (0: every tick). Charts drawn from such a
    /// stream should read `held`: `values` of the frames skipped in between are not sent.
    pub min_period_ms: u32,
}

impl Default for LiveRequest {
    fn default() -> Self {
        Self {
            backfill_ms: DEFAULT_BACKFILL_MS,
            series: None,
            min_period_ms: 0,
        }
    }
}

/// How often a stream paced to `min_period_ms` sends frames at `interval_ms`: the
/// smallest multiple of the interval that `Stream::on_frame`'s half-interval tolerance
/// lets through.
pub fn frame_period_ms(interval_ms: u32, min_period_ms: i64) -> u32 {
    let interval = i64::from(interval_ms.max(1));
    if min_period_ms <= interval {
        return interval_ms;
    }
    let ticks = (min_period_ms - interval / 2 + interval - 1) / interval;
    u32::try_from(ticks.max(1) * interval).unwrap_or(u32::MAX)
}

/// The shortest frame period a visible window gets in Performance mode (D-088).
const PERFORMANCE_MIN_PERIOD_MS: i64 = statglass_engine::PERFORMANCE_VISIBLE_MS as i64;

/// A stream's frame pacing: what it asked for, raised to 2 s in Performance mode.
pub fn effective_min_period_ms(requested: i64, performance: PerformanceReason) -> i64 {
    if performance.is_on() {
        requested.max(PERFORMANCE_MIN_PERIOD_MS)
    } else {
        requested
    }
}

fn status_msg(s: &EngineStatus, min_period_ms: i64) -> LiveStatus {
    let min_period_ms = effective_min_period_ms(min_period_ms, s.performance);
    LiveStatus {
        interval_ms: s.interval_ms,
        frame_period_ms: frame_period_ms(s.interval_ms, min_period_ms),
        paused: s.paused,
        display_idle: s.display_idle,
        on_battery: s.on_battery,
        performance: s.performance,
        power_source: s.power_source,
        primary_iface: s.primary_iface.as_deref().map(str::to_owned),
    }
}

/// Which values of a layout a stream sends: `None` is all of them.
type Pick = Option<Arc<[usize]>>;

fn pick_for(layout: &FrameLayout, series: Option<&[SeriesSelector]>) -> Pick {
    let sel = series?;
    Some(
        layout
            .series
            .iter()
            .enumerate()
            .filter(|(_, k)| sel.iter().any(|s| s.matches(k)))
            .map(|(i, _)| i)
            .collect(),
    )
}

fn pick_values(pick: &Pick, v: &[f32]) -> Vec<Option<f32>> {
    let one = |x: f32| x.is_finite().then_some(x);
    match pick {
        None => v.iter().map(|&x| one(x)).collect(),
        Some(idx) => idx
            .iter()
            .map(|&i| v.get(i).copied().and_then(one))
            .collect(),
    }
}

fn pick_holds(pick: &Pick, holds: &[u32]) -> Vec<u32> {
    match pick {
        None => holds.to_vec(),
        Some(idx) => idx
            .iter()
            .map(|&i| holds.get(i).copied().unwrap_or(0))
            .collect(),
    }
}

/// The receiver went away.
struct Closed;

#[derive(Default)]
struct CatchUp {
    first: Option<i64>,
    rows: u32,
    earlier_start: Option<i64>,
    earlier_rows: u32,
}

fn len_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn len_i64(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// What one stream has sent, so a resume sends only what is missing.
struct Stream {
    feed: Arc<dyn LiveFeed>,
    sink: Arc<dyn LiveSink>,
    backfill_ms: i64,
    series: Option<Vec<SeriesSelector>>,
    min_period_ms: i64,
    /// This window's process view while its interest is active for this stream.
    procs: Arc<Mutex<Option<ProcessView>>>,
    refusals: Option<Arc<dyn RefusalSource>>,
    /// The last layout a pick was computed for.
    pick: Option<(Arc<FrameLayout>, Pick)>,
    /// The last layout sent.
    layout_no: Option<u32>,
    /// The frame holds the last `Holds` was built from (the engine's `Arc` and this
    /// stream's frame period), and what it sent.
    holds_from: Option<(Arc<[u32]>, u32)>,
    holds_sent: Option<(u32, Vec<u32>)>,
    /// Timestamp of the last row or frame sent.
    last_ts: Option<i64>,
    /// The source's clock timeline of the last row or frame sent.
    timeline: Option<u32>,
    /// Frames at or before this were already sent as backfill rows. Ring rows carry
    /// nominal times (`start + i * interval`) while frames carry the real tick time, so
    /// the bound is the last row plus half an interval.
    sent_until: i64,
    last_frame_ts: Option<i64>,
    last_procs_ts: Option<i64>,
    caps_revision: Option<u64>,
    status: Option<LiveStatus>,
    /// From the last engine status: Performance mode paces frames to at least 2 s.
    performance: PerformanceReason,
    display_idle: bool,
    /// Older history still to send, newest chunk first.
    earlier: VecDeque<BackfillSegment>,
    /// Older history may go: a frame went out since it was queued, or `earlier_at` passed.
    earlier_go: bool,
    earlier_at: Instant,
    /// The plan told the window to wait for a refill the source had not made yet
    /// ([`LiveHub::refill_pending`]), until this frame time at the latest; if the
    /// refill adds nothing or never comes, a plan says so.
    awaiting_refill: Option<i64>,
}

impl Stream {
    fn new(
        feed: Arc<dyn LiveFeed>,
        sink: Arc<dyn LiveSink>,
        req: LiveRequest,
        procs: Arc<Mutex<Option<ProcessView>>>,
        refusals: Option<Arc<dyn RefusalSource>>,
    ) -> Self {
        Self {
            feed,
            sink,
            backfill_ms: req.backfill_ms.clamp(0, MAX_BACKFILL_MS),
            series: req.series,
            min_period_ms: i64::from(req.min_period_ms),
            procs,
            refusals,
            pick: None,
            layout_no: None,
            holds_from: None,
            holds_sent: None,
            last_ts: None,
            timeline: None,
            sent_until: i64::MIN,
            last_frame_ts: None,
            last_procs_ts: None,
            caps_revision: None,
            performance: PerformanceReason::Off,
            status: None,
            display_idle: false,
            earlier: VecDeque::new(),
            earlier_go: false,
            earlier_at: Instant::now(),
            awaiting_refill: None,
        }
    }

    fn send(&self, msg: LiveMsg) -> Result<(), Closed> {
        if self.sink.send(msg) {
            Ok(())
        } else {
            Err(Closed)
        }
    }

    fn pick(&mut self, layout: &Arc<FrameLayout>) -> Pick {
        match &self.pick {
            Some((l, p)) if Arc::ptr_eq(l, layout) => p.clone(),
            _ => {
                let p = pick_for(layout, self.series.as_deref());
                self.pick = Some((Arc::clone(layout), p.clone()));
                p
            }
        }
    }

    fn send_layout(&mut self, layout: &Arc<FrameLayout>) -> Result<(), Closed> {
        if self.layout_no != Some(layout.layout_no) {
            let series = match self.pick(layout) {
                None => layout.series.to_vec(),
                Some(idx) => idx
                    .iter()
                    .filter_map(|&i| layout.series.get(i).cloned())
                    .collect(),
            };
            let catalog = Catalog::builtin();
            let kinds = series
                .iter()
                .map(|k| {
                    catalog
                        .get(k.metric.as_str())
                        .map_or(MetricKind::Gauge, |d| d.kind)
                })
                .collect();
            self.send(LiveMsg::Layout {
                layout_no: layout.layout_no,
                series,
                kinds,
            })?;
            self.layout_no = Some(layout.layout_no);
        }
        Ok(())
    }

    fn send_caps(&mut self, caps: Capabilities) -> Result<(), Closed> {
        if self.caps_revision != Some(caps.revision) {
            self.caps_revision = Some(caps.revision);
            self.send(LiveMsg::Caps { capabilities: caps })?;
        }
        Ok(())
    }

    fn send_status(&mut self, s: &EngineStatus) -> Result<(), Closed> {
        self.performance = s.performance;
        let mut status = status_msg(s, self.min_period_ms);
        status.frame_period_ms = status.frame_period_ms.max(self.feed.min_frame_period_ms());
        status.display_idle &= self.feed.is_local();
        self.display_idle = status.display_idle;
        if self.status.as_ref() != Some(&status) {
            self.status = Some(status.clone());
            self.send(LiveMsg::Status(status))?;
        }
        Ok(())
    }

    /// What follows is on another timeline: the host's clock stepped, or a remote
    /// source refilled its ring from history.
    fn restart_timeline(&mut self) {
        tracing::info!(host = %self.feed.host(), "live channel restarts on a new timeline");
        self.last_ts = None;
        self.timeline = None;
        self.sent_until = i64::MIN;
        self.last_frame_ts = None;
        self.last_procs_ts = None;
        self.earlier.clear();
        self.holds_from = None;
        self.holds_sent = None;
    }

    fn on_frame(&mut self, f: &LiveFrame) -> Result<(), Closed> {
        if self.display_idle {
            return Ok(());
        }
        if self.timeline.is_some_and(|t| t != f.timeline) {
            // The source's clock stepped (D-064), or a remote source refilled its ring
            // from history: send the ring's rows on the new timeline. Without this the
            // stream would skip every frame until the clock caught up with what it had
            // sent. The frame still goes out for its readouts; the window drops it as a
            // duplicate row.
            self.catch_up()?;
            self.sent_until = i64::MIN;
            self.last_frame_ts = None;
        } else {
            if let Some(deadline) = self.awaiting_refill
                && (!self.feed.hub().refill_pending() || f.ts_ms >= deadline)
            {
                if self
                    .feed
                    .hub()
                    .backfill_anchor()
                    .is_some_and(|(_, ring)| Some(ring) != self.timeline)
                {
                    // The refill landed while this frame, from before it, sat on the
                    // bus: restart on the ring's new timeline, whose plan ends the
                    // wait. The frame belongs to the old one and is dropped.
                    self.catch_up()?;
                    self.sent_until = i64::MIN;
                    self.last_frame_ts = None;
                    return Ok(());
                }
                // The refill the window waits for added nothing, or has not come in
                // REFILL_WAIT_MS, so no new timeline follows to end the wait.
                self.awaiting_refill = None;
                self.send(LiveMsg::BackfillPlan {
                    recent_rows: 0,
                    earlier_start_ms: None,
                })?;
            }
            if f.ts_ms <= self.sent_until {
                // Already sent as a backfill row (published between the subscribe and
                // the ring read).
                return Ok(());
            }
        }
        let tolerance = i64::from(f.interval_ms) / 2;
        let min_period_ms = effective_min_period_ms(self.min_period_ms, self.performance);
        if min_period_ms > 0
            && self.layout_no == Some(f.layout.layout_no)
            && self
                .last_frame_ts
                .is_some_and(|t| f.ts_ms - t + tolerance < min_period_ms)
        {
            return Ok(());
        }
        self.send_layout(&f.layout)?;
        let pick = self.pick(&f.layout);
        self.send_holds(f, &pick)?;
        self.send(LiveMsg::Frame {
            ts_ms: f.ts_ms,
            layout_no: f.layout.layout_no,
            timeline: f.timeline,
            values: pick_values(&pick, &f.values),
            held: pick_values(&pick, &f.held),
        })?;
        self.last_ts = Some(f.ts_ms);
        self.timeline = Some(f.timeline);
        self.sent_until = f.ts_ms;
        self.last_frame_ts = Some(f.ts_ms);
        self.earlier_go = true;
        Ok(())
    }

    /// Sends `Holds` before `f` when its holds differ from the last ones sent. A thinned
    /// stream's frames are a frame period apart, so no hold is shorter than that period's.
    fn send_holds(&mut self, f: &LiveFrame, pick: &Pick) -> Result<(), Closed> {
        let frame_period = self
            .status
            .as_ref()
            .map_or(f.interval_ms, |s| s.frame_period_ms);
        if self
            .holds_from
            .as_ref()
            .is_some_and(|(h, p)| Arc::ptr_eq(h, &f.holds) && *p == frame_period)
            && self.holds_sent.as_ref().map(|(no, _)| *no) == Some(f.layout.layout_no)
        {
            return Ok(());
        }
        self.holds_from = Some((Arc::clone(&f.holds), frame_period));
        let floor = statglass_engine::hold_ms(frame_period);
        let holds: Vec<u32> = pick_holds(pick, &f.holds)
            .into_iter()
            .map(|h| h.max(floor))
            .collect();
        if self
            .holds_sent
            .as_ref()
            .is_some_and(|(no, sent)| *no == f.layout.layout_no && *sent == holds)
        {
            return Ok(());
        }
        self.send(LiveMsg::Holds {
            layout_no: f.layout.layout_no,
            holds_ms: holds.clone(),
        })?;
        self.holds_sent = Some((f.layout.layout_no, holds));
        Ok(())
    }
}

mod backfill;
mod delivery;
mod registry;
pub use registry::{LiveRegistry, RecentFeed};

#[cfg(test)]
mod tests;
