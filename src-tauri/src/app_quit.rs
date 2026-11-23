//! Which of an app's processes Quit acts on, decided over each live batch
//! (`LiveProcess.app_quit`, from [`live_quit_set`]). Every view that offers an app row's
//! Quit reads it from there: the process table directly, per-app usage and recorded
//! tables by app name.

use std::collections::{HashMap, HashSet};

use statglass_engine::ProcessSample;

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
mod tests {
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
