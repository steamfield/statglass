//! Live process rows, app quit targets and a per-batch refusal supplied by the app.
//!
//! When the registry has no refusal source, `LiveProcess::refusal` is `None` because
//! no rule was applied. [`live_quit_set`] computes the quit targets over the whole batch.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use statglass_engine::{ProcessSample, ProcessView, select_processes};
use statglass_schema::JsSafeInt;

/// Why StatGlass will not signal a process. The UI words it (`process-signal.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SignalRefusal {
    /// The macOS kernel (pid 0), or a pid kill(2) would treat as a process group.
    KernelTask,
    Launchd,
    WindowServer,
    LoginWindow,
    /// StatGlass itself or one of its helpers.
    #[serde(rename = "statglass")]
    StatGlass,
}

/// The refusal rule for one live batch, taking `(pid, start_time_us, name)`.
pub type RefusalRule<'a> = Box<dyn Fn(i32, i64, &str) -> Option<SignalRefusal> + 'a>;

/// Per-batch refusal rule. The desktop supplies process_signal's; a phone supplies none.
pub trait RefusalSource: Send + Sync {
    /// The rule for one live batch. Anything it needs once per batch (this process's
    /// pid, StatGlass's own processes) is read here.
    fn batch(&self) -> RefusalRule<'_>;
}

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
        refusal: &dyn Fn(i32, i64, &str) -> Option<SignalRefusal>,
    ) -> Vec<LiveProcess> {
        let quit_set = live_quit_set(rows);
        select_processes(rows, view, |r| Self::from_sample(r, &quit_set, refusal))
    }

    /// One sampled process. `quit_set` and the refusal rule are computed once per batch.
    pub fn from_sample(
        r: &ProcessSample,
        quit_set: &HashSet<(i32, i64)>,
        refusal: &dyn Fn(i32, i64, &str) -> Option<SignalRefusal>,
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

/// The indices into `procs` (one app's processes, all running) that Quit on the app acts
/// on: its main executables alone when there are any (one per running instance of the
/// app), since quitting them quits the app and signalling its helpers first would cut a
/// graceful quit short; otherwise every process. Empty when `procs` is.
fn quit_targets<P>(procs: &[P], main: impl Fn(&P) -> bool) -> Vec<usize> {
    let mains: Vec<usize> = procs
        .iter()
        .enumerate()
        .filter(|(_, p)| main(p))
        .map(|(i, _)| i)
        .collect();
    if mains.is_empty() {
        (0..procs.len()).collect()
    } else {
        mains
    }
}

/// The `(pid, start_time_us)` of every row in `rows` that Quit on its app acts on. Rows
/// group by app name, or by their own name when they have no app, and every row in the
/// batch counts as running.
pub fn live_quit_set(rows: &[ProcessSample]) -> HashSet<(i32, i64)> {
    let mut groups: HashMap<&str, Vec<&ProcessSample>> = HashMap::new();
    for r in rows {
        groups
            .entry(r.app.as_deref().unwrap_or(&r.name))
            .or_default()
            .push(r);
    }
    groups
        .values()
        .flat_map(|members| {
            quit_targets(members, |r| r.app_main)
                .into_iter()
                .filter_map(|i| members.get(i))
                .map(|r| (r.pid, r.start_time_us))
        })
        .collect()
}

#[cfg(test)]
mod quit_tests {
    use super::{live_quit_set, quit_targets};
    use statglass_engine::ProcessSample;

    /// Whether each process is its app's main executable.
    fn targets(mains: &[bool]) -> Vec<usize> {
        quit_targets(mains, |&main| main)
    }

    #[test]
    fn main_alone() {
        assert_eq!(targets(&[false, true, false]), vec![1]);
    }

    #[test]
    fn no_main_means_every_process() {
        assert_eq!(targets(&[false, false, false]), vec![0, 1, 2]);
    }

    #[test]
    fn no_process_is_empty() {
        assert_eq!(targets(&[]), Vec::<usize>::new());
    }

    fn sample(pid: i32, name: &str, app: Option<&str>, app_main: bool) -> ProcessSample {
        ProcessSample {
            pid,
            start_time_us: i64::from(pid) * 10,
            name: name.into(),
            app: app.map(Into::into),
            app_main,
            cpu_pct: 0.0,
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

    fn keys(pids: &[i32]) -> std::collections::HashSet<(i32, i64)> {
        pids.iter().map(|&p| (p, i64::from(p) * 10)).collect()
    }

    #[test]
    fn helper_is_left_out_when_its_main_is_in_the_batch() {
        let rows = [
            sample(1, "Safari Helper", Some("Safari"), false),
            sample(2, "Safari", Some("Safari"), true),
        ];
        assert_eq!(live_quit_set(&rows), keys(&[2]));
    }

    #[test]
    fn app_without_main_puts_every_row_in_the_set() {
        let rows = [
            sample(1, "Helper A", Some("Chat"), false),
            sample(2, "Helper B", Some("Chat"), false),
        ];
        assert_eq!(live_quit_set(&rows), keys(&[1, 2]));
    }

    #[test]
    fn row_without_app_groups_under_its_own_name() {
        let rows = [
            sample(1, "Safari", None, false),
            sample(2, "Safari", Some("Safari"), true),
            sample(3, "sshd", None, false),
        ];
        assert_eq!(live_quit_set(&rows), keys(&[2, 3]));
    }

    #[test]
    fn every_running_instance_of_an_app_is_quit() {
        let rows = [
            sample(1, "Foo", Some("Foo"), true),
            sample(2, "Foo Helper", Some("Foo"), false),
            sample(3, "Foo", Some("Foo"), true),
        ];
        assert_eq!(live_quit_set(&rows), keys(&[1, 3]));
    }
}
