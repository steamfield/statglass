//! Which of an app's processes Quit acts on. One rule for every view that offers an app
//! row's Quit: the live process table (`LiveProcess.app_quit`) and the per-app usage
//! answer (`AppUsage.quit_pids`).

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

#[cfg(test)]
mod tests {
    use super::quit_targets;

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
}
