//! Which of an app's processes Quit acts on. One rule for every view that offers an app
//! row's Quit: the live process table (`LiveProcess.app_quit`) and the per-app usage
//! answer (`AppUsage.quit_pids`).

use std::collections::{HashMap, HashSet};

use statglass_engine::ProcessSample;

/// The indices into `procs` that Quit on their app acts on: the running main executable
/// alone when there is one, since quitting it quits the app and signalling its helpers
/// first would cut a graceful quit short; otherwise every running process. Empty when
/// none is running.
pub fn quit_targets<P>(
    procs: &[P],
    running: impl Fn(&P) -> bool,
    main: impl Fn(&P) -> bool,
) -> Vec<usize> {
    if let Some(i) = procs.iter().position(|p| running(p) && main(p)) {
        return vec![i];
    }
    procs
        .iter()
        .enumerate()
        .filter(|(_, p)| running(p))
        .map(|(i, _)| i)
        .collect()
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
            quit_targets(members, |_| true, |r| r.app_main)
                .into_iter()
                .filter_map(|i| members.get(i))
                .map(|r| (r.pid, r.start_time_us))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{live_quit_set, quit_targets};
    use statglass_engine::ProcessSample;

    /// (running, main)
    type P = (bool, bool);

    fn targets(procs: &[P]) -> Vec<usize> {
        quit_targets(procs, |p| p.0, |p| p.1)
    }

    #[test]
    fn running_main_alone() {
        assert_eq!(
            targets(&[(true, false), (true, true), (true, false)]),
            vec![1]
        );
    }

    #[test]
    fn no_main_means_every_running_process() {
        assert_eq!(
            targets(&[(true, false), (false, false), (true, false)]),
            vec![0, 2]
        );
    }

    #[test]
    fn exited_main_falls_back_to_running_members() {
        assert_eq!(
            targets(&[(false, true), (true, false), (true, false)]),
            vec![1, 2]
        );
    }

    #[test]
    fn nothing_running_is_empty() {
        assert_eq!(
            targets(&[(false, true), (false, false)]),
            Vec::<usize>::new()
        );
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
            sample(1, "sshd", None, false),
            sample(2, "zsh", None, false),
            sample(3, "Safari", Some("Safari"), true),
        ];
        assert_eq!(live_quit_set(&rows), keys(&[1, 2, 3]));
    }
}
