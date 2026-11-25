//! Messages and initial result for a live subscription.
use super::*;
use crate::process::LiveProcess;
use serde::Serialize;
use statglass_schema::{JsSafeInt, PowerSource, SeriesKey};

/// One message on a window's live channel (D-049, D-066).
///
/// Order on a fresh subscription: the current `Caps` and `Status`; a `Layout` for every
/// layout the requested history uses; then the most recent two minutes as `Backfill`
/// segments (each after its `Layout` when that differs from the last one sent); then
/// frames, preceded by a `Layout` when it changes. A `BackfillPlan` precedes the
/// `Backfill` messages of a catch-up that starts history over; on a clock step it can
/// come before that segment's `Layout`. Older `BackfillEarlier` chunks follow newest
/// first once the first frame is out or after `EARLIER_AFTER`, or all at once when the
/// window hides, whichever is first. Each is older than everything sent before it.
///
/// After the channel resumes (window shown, display awake, the stream fell behind the
/// bus): `Caps` and `Status` if they changed, then `Backfill` for exactly the span missed,
/// in time order and in segments of at most 600 rows (one message each, so applying them
/// never blocks the webview for long), so `Backfill` rows come after everything already
/// received.
///
/// `timeline` on `Backfill` and `Frame` numbers the runs of the host's wall clock: the
/// host bumps it when its clock is stepped (D-064) and for nothing else. Rows with a
/// `timeline` other than the one held replace everything held at or after their first
/// row's time. After a step the channel sends the new timeline from its first row (as far
/// back as the window's backfill span reaches), so that time is where the step happened.
///
/// A subscription that named `series` gets only those series: `Layout.series` lists the
/// matching keys and every row and frame carries values for them alone.
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LiveMsg {
    /// What a catch-up that starts the window's history over is about to send: `recent_rows`
    /// rows as the `Backfill` messages that follow at once, then everything from
    /// `earlier_start_ms` up to them as `BackfillEarlier` chunks (`null` when no older
    /// history follows). Sent once per such catch-up, before its first `Backfill`, so a
    /// reader can hold a chart back until its window is whole. A resume that only sends the
    /// span missed sends no plan.
    BackfillPlan {
        recent_rows: u32,
        #[specta(type = Option<JsSafeInt>)]
        earlier_start_ms: Option<i64>,
    },
    /// The series of every following `Backfill` and `Frame` with this `layout_no`, in
    /// value order, and each one's catalog kind (`gauge` for a metric this build does not
    /// know). `layout_no` numbers layouts within one engine run.
    Layout {
        layout_no: u32,
        series: Vec<SeriesKey>,
        kinds: Vec<MetricKind>,
    },
    /// Raw measured rows from the engine's one-hour ring: row `i` was taken at about
    /// `start_ms + i * interval_ms`. `null` where a series was not sampled. Segments never
    /// span a hole (sleep, pause, skipped ticks), so a reader never draws across one.
    /// `holds_ms` says, per series, how long a sample in these rows stays current (D-090).
    /// After a restart the ring starts with up to an hour of stored 10 s bucket averages
    /// under their own layout (`layout_no` 4294967295, D-097), so these rows can be that.
    Backfill {
        layout_no: u32,
        #[specta(type = JsSafeInt)]
        start_ms: i64,
        interval_ms: u32,
        timeline: u32,
        rows: Vec<Vec<Option<f32>>>,
        holds_ms: Vec<u32>,
    },
    /// History older than everything sent so far on this channel, in the same shape as
    /// `Backfill`. Its `layout_no` was announced by an earlier `Layout`.
    BackfillEarlier {
        layout_no: u32,
        #[specta(type = JsSafeInt)]
        start_ms: i64,
        interval_ms: u32,
        rows: Vec<Vec<Option<f32>>>,
        holds_ms: Vec<u32>,
    },
    /// How long each series' sample stays current in the frames that follow, in
    /// `layout_no` order (D-090). Sent before the first frame and whenever it changes: a
    /// collector slowing down with no window open, back-off on battery, a thinned
    /// stream. Two samples of a series further apart than the earlier one's hold have a
    /// gap between them; closer ones are one run.
    Holds {
        layout_no: u32,
        holds_ms: Vec<u32>,
    },
    /// One tick. `values` is what was measured on this tick (`null` for a series not
    /// sampled now); draw charts from it. `held` is the latest value of each series while
    /// it is still current (`null` once stale, D-047); read current numbers and build the
    /// Snapshot from it. Both are in `layout_no` order.
    Frame {
        #[specta(type = JsSafeInt)]
        ts_ms: i64,
        layout_no: u32,
        timeline: u32,
        values: Vec<Option<f32>>,
        held: Vec<Option<f32>>,
    },
    /// Process rows, sent only while this window has process interest for the host:
    /// every readable process, or the top rows its [`ProcessView`] asked for, sorted by
    /// the view's first sort key.
    Processes {
        #[specta(type = JsSafeInt)]
        ts_ms: i64,
        rows: Vec<LiveProcess>,
    },
    Caps {
        capabilities: Capabilities,
    },
    /// Engine state, sent when it changes.
    Status(LiveStatus),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct LiveStatus {
    /// The base tick in effect, after battery back-off.
    pub interval_ms: u32,
    /// How often this channel sends frames: the base tick, or the multiple of it the
    /// subscription's `min_period_ms` thins frames to. Stale is measured in these.
    pub frame_period_ms: u32,
    pub paused: bool,
    /// The display is asleep or the screen locked: no frames are sent until it wakes,
    /// then the missed span arrives as `Backfill`. Not stale.
    pub display_idle: bool,
    pub on_battery: bool,
    /// Whether Performance mode is in effect, and why: the setting or Low Power Mode
    /// (D-088). Frames are paced to at least 2 s while it is.
    pub performance: PerformanceReason,
    /// Battery, adapter or charging, read with `on_battery`; a Mac without a battery is
    /// `adapter` (D-092).
    pub power_source: PowerSource,
    /// The `iface` label of the reported interface carrying the default route, `null`
    /// when the route is on an interface StatGlass does not report (a VPN tunnel) or there is
    /// none. Re-read on interface changes and every 60 s (D-092).
    pub primary_iface: Option<String>,
}

/// What `subscribe_live` did before returning.
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct SubscriptionInfo {
    pub host: HostId,
    /// This subscription's id (the channel's): pass it to `set_process_interest` so the
    /// interest belongs to this page load and ends with it.
    pub stream: u32,
    /// Start of the backfill already sent on the channel, `null` when none was (the ring is
    /// empty, or the window is hidden and the channel starts when it is shown).
    #[specta(type = Option<JsSafeInt>)]
    pub backfill_start_ms: Option<i64>,
    /// Backfill rows sent, over all segments.
    pub backfill_rows: u32,
    /// Start of the older history that follows as `BackfillEarlier` chunks, `null` when
    /// none does.
    #[specta(type = Option<JsSafeInt>)]
    pub earlier_start_ms: Option<i64>,
    /// Rows still to come in `BackfillEarlier` chunks.
    pub earlier_rows: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The JSON the channel carries, which the generated `LiveMsg` type must describe: a
    /// flat object with a `kind` tag (D-048).
    #[test]
    fn live_msg_is_internally_tagged_json() {
        let frame = LiveMsg::Frame {
            ts_ms: 1_700_000_000_000,
            layout_no: 3,
            timeline: 0,
            values: vec![None, Some(1.5)],
            held: vec![Some(1.0), Some(1.5)],
        };
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            serde_json::json!({
                "kind": "frame",
                "ts_ms": 1_700_000_000_000_i64,
                "layout_no": 3,
                "timeline": 0,
                "values": [null, 1.5],
                "held": [1.0, 1.5],
            })
        );
        let status = LiveMsg::Status(LiveStatus {
            interval_ms: 1000,
            frame_period_ms: 1000,
            paused: false,
            display_idle: false,
            on_battery: true,
            performance: PerformanceReason::LowPowerMode,
            power_source: PowerSource::Battery,
            primary_iface: Some("en0".into()),
        });
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "kind": "status",
                "interval_ms": 1000,
                "frame_period_ms": 1000,
                "paused": false,
                "display_idle": false,
                "on_battery": true,
                "performance": "low_power_mode",
                "power_source": "battery",
                "primary_iface": "en0",
            })
        );
        let caps = LiveMsg::Caps {
            capabilities: Capabilities::default(),
        };
        assert_eq!(
            serde_json::to_value(&caps).unwrap()["kind"],
            serde_json::json!("caps")
        );
    }
}
