//! `LiveProcess`: one process row of `LiveMsg::Processes`, re-exported from `ipc`.

use std::collections::HashSet;

use serde::Serialize;
use statglass_engine::{ProcessSample, ProcessView, select_processes};
use statglass_schema::JsSafeInt;

use crate::process_signal::SignalRefusal;

/// One process at one sample (v1-local-monitor.md 6.2).
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct LiveProcess {
    pub pid: i32,
    /// Process start, microseconds since the Unix epoch. With `pid` it identifies the
    /// process, since pids are reused.
    #[specta(type = JsSafeInt)]
    pub start_time_us: i64,
    pub name: String,
    /// Percent of one core; can exceed 100.
    pub cpu_pct: f32,
    #[specta(type = JsSafeInt)]
    pub mem_bytes: u64,
    /// `null` when the platform does not say.
    #[specta(type = Option<JsSafeInt>)]
    pub compressed_bytes: Option<u64>,
    pub threads: u32,
    pub idle_wakeups_per_s: f32,
    pub energy: f32,
    pub disk_read_bps: f32,
    pub disk_write_bps: f32,
    /// Bytes per second received, loopback excluded. `null` when per-process network was
    /// not sampled: no visible view asked for it (`ProcessView.network`), or
    /// `Capabilities.process_network` is false. Covers the current user's processes only
    /// (D-081).
    pub net_rx_bps: Option<f32>,
    /// Bytes per second sent; see `net_rx_bps`.
    pub net_tx_bps: Option<f32>,
    /// Share of the whole GPU over the interval, 0 to 100: the GPU time the process's
    /// work used divided by wall time. `null` when not sampled: no visible view asked for
    /// it (`ProcessView.gpu`), or `Capabilities.process_gpu` is false. Approximate while
    /// a long compute job runs: time is charged when a command buffer completes (D-085).
    pub gpu_pct: Option<f32>,
    /// TCP ports the process listens on, ascending; empty when none. `null` when not read:
    /// no visible view asked for them (`ProcessView.ports`). Covers the current user's
    /// processes only, like every row.
    pub ports: Option<Vec<u16>>,
    pub user: String,
    /// Why Quit and Force Quit refuse this process, `null` when they may signal it: the
    /// rule `process_signal` checks, with StatGlass's own processes from the self-CPU
    /// collector's list (D-092).
    pub refusal: Option<SignalRefusal>,
    /// The app this process belongs to, by the identity rule per-app usage groups by
    /// (D-089): "Google Chrome" for its helpers, `node` for a CLI. The process name when no
    /// app was resolved. Tables group rows by it.
    pub app: String,
    /// Quit on this process's app acts on it: the app's running main executables when it
    /// has any, otherwise every process of the app. Decided over the whole sample, before
    /// the view's limit (`app_quit::live_quit_set`); per-app and recorded tables quit
    /// through it by app name.
    pub app_quit: bool,
}

impl LiveProcess {
    /// The rows `view` asks for out of one sampled batch. Which processes Quit on their app
    /// acts on is decided over the whole batch first, so a helper kept by the view's limit
    /// still knows its app's main was running even when the main itself was cut.
    pub fn select(
        rows: &[ProcessSample],
        view: &ProcessView,
        refusal: &impl Fn(i32, i64, &str) -> Option<SignalRefusal>,
    ) -> Vec<LiveProcess> {
        let quit_set = crate::app_quit::live_quit_set(rows);
        select_processes(rows, view, |r| Self::from_sample(r, &quit_set, refusal))
    }

    /// The webview's row for one sampled process. `quit_set` is the batch's
    /// [`crate::app_quit::live_quit_set`] and `refusal` is [`crate::process_signal::refusals`],
    /// both read once per batch.
    pub fn from_sample(
        r: &ProcessSample,
        quit_set: &HashSet<(i32, i64)>,
        refusal: &impl Fn(i32, i64, &str) -> Option<SignalRefusal>,
    ) -> LiveProcess {
        LiveProcess {
            pid: r.pid,
            start_time_us: r.start_time_us,
            name: r.name.to_string(),
            cpu_pct: r.cpu_pct,
            mem_bytes: r.mem_bytes,
            compressed_bytes: r.compressed_bytes,
            threads: r.threads,
            idle_wakeups_per_s: r.idle_wakeups_per_s,
            energy: r.energy,
            disk_read_bps: r.disk_read_bps,
            disk_write_bps: r.disk_write_bps,
            net_rx_bps: r.net_rx_bps,
            net_tx_bps: r.net_tx_bps,
            gpu_pct: r.gpu_pct,
            ports: r.ports.as_deref().map(<[u16]>::to_vec),
            user: r.user.to_string(),
            refusal: refusal(r.pid, r.start_time_us, &r.name),
            app: r.app.as_deref().unwrap_or(&r.name).to_string(),
            app_quit: quit_set.contains(&(r.pid, r.start_time_us)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LiveProcess;
    use statglass_engine::{ProcessSample, ProcessSort, ProcessView};

    fn sample(pid: i32, name: &str, app_main: bool, cpu_pct: f32) -> ProcessSample {
        ProcessSample {
            pid,
            start_time_us: i64::from(pid),
            name: name.into(),
            app: Some("Safari".into()),
            app_main,
            cpu_pct,
            mem_bytes: 0,
            compressed_bytes: None,
            threads: 1,
            idle_wakeups_per_s: 0.0,
            energy: 0.0,
            energy_j: 0.0,
            interval_s: 1.0,
            disk_read_bps: 0.0,
            disk_write_bps: 0.0,
            net_rx_bps: None,
            net_tx_bps: None,
            gpu_pct: None,
            ports: None,
            user: "me".into(),
        }
    }

    #[test]
    fn quit_targets_come_from_the_whole_batch_before_the_limit() {
        let rows = [
            sample(1, "Safari", true, 0.1),
            sample(2, "Safari Web Content", false, 90.0),
        ];
        let view = ProcessView {
            limit: Some(1),
            sort: vec![ProcessSort::Cpu],
            ..ProcessView::default()
        };
        let picked = LiveProcess::select(&rows, &view, &|_, _, _| None);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].pid, 2);
        assert_eq!(picked[0].app, "Safari");
        assert!(!picked[0].app_quit, "the cut main is still the quit target");
    }
}
