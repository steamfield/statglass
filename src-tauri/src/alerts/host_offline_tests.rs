//! The host-offline watch, driven the way the poll drives it: one observation of every
//! saved host every 30 s, with the production five minutes and 90 s maximum step.

use statglass_schema::HostId;
use uuid::Uuid;

use super::host_offline::{HostNotice, HostObservation, HostOfflineWatch};

const STEP: i64 = 30_000;
const MIN: i64 = 60_000;

fn watch() -> HostOfflineWatch {
    HostOfflineWatch::new(300_000, 90_000)
}

fn host(n: u128) -> HostId {
    HostId(Uuid::from_u128(n))
}

fn name(n: u128) -> String {
    format!("host-{n}")
}

fn seen(n: u128, reachable: bool) -> HostObservation {
    HostObservation {
        host: host(n),
        name: name(n),
        reachable,
        counts: true,
    }
}

fn uncounted(n: u128, reachable: bool) -> HostObservation {
    HostObservation {
        counts: false,
        ..seen(n, reachable)
    }
}

fn offline(n: u128, since_ms: i64) -> HostNotice {
    HostNotice::Offline {
        host: host(n),
        name: name(n),
        since_ms,
    }
}

fn back(n: u128, since_ms: i64, offline_ms: i64) -> HostNotice {
    HostNotice::Back {
        host: host(n),
        name: name(n),
        since_ms,
        offline_ms,
    }
}

/// Observes every 30 s from `from_ms` up to and including `to_ms`, with the hosts
/// `at` gives for each time, and returns every notice with the time it came at.
fn run(
    watch: &mut HostOfflineWatch,
    from_ms: i64,
    to_ms: i64,
    at: impl Fn(i64) -> Vec<HostObservation>,
) -> Vec<(i64, HostNotice)> {
    let mut notices = Vec::new();
    let mut now = from_ms;
    while now <= to_ms {
        for notice in watch.observe(now, &at(now)) {
            notices.push((now, notice));
        }
        now += STEP;
    }
    notices
}

#[test]
fn a_host_unreachable_for_five_observed_minutes_is_offline_once() {
    let mut w = watch();
    let notices = run(&mut w, 0, 10 * MIN, |t| vec![seen(1, t < 60_000)]);
    // First seen unreachable at 1 min, so offline at 6 min.
    assert_eq!(notices, [(6 * MIN, offline(1, MIN))]);
}

#[test]
fn a_host_that_stays_offline_gives_nothing_more() {
    let mut w = watch();
    let notices = run(&mut w, 0, 3 * 60 * MIN, |_| vec![seen(1, false)]);
    assert_eq!(notices, [(5 * MIN, offline(1, 0))]);
}

#[test]
fn a_host_reachable_again_after_offline_is_back_once_with_its_offline_span() {
    let mut w = watch();
    let notices = run(&mut w, 0, 60 * MIN, |t| {
        vec![seen(1, !(MIN..42 * MIN + MIN).contains(&t))]
    });
    assert_eq!(
        notices,
        [
            (6 * MIN, offline(1, MIN)),
            (43 * MIN, back(1, MIN, 42 * MIN))
        ]
    );
}

#[test]
fn a_host_that_recovers_before_five_minutes_gives_nothing_and_counts_again_from_zero() {
    let mut w = watch();
    // Unreachable 0..4 min, reachable for a minute, then unreachable for good: the
    // first run never reaches five minutes, and the second counts from its own start.
    let notices = run(&mut w, 0, 20 * MIN, |t| {
        vec![seen(1, (4 * MIN..5 * MIN).contains(&t))]
    });
    assert_eq!(notices, [(10 * MIN, offline(1, 5 * MIN))]);
}

#[test]
fn time_across_a_sleep_is_not_counted_and_restarts_the_count() {
    let mut w = watch();
    // Unreachable from 0 to 4 min of observations...
    let before = run(&mut w, 0, 4 * MIN, |_| vec![seen(1, false)]);
    assert_eq!(before, []);
    // ...then this Mac sleeps 10 minutes; the next observation starts a new count.
    let wake = 14 * MIN;
    let after = run(&mut w, wake, wake + 10 * MIN, |_| vec![seen(1, false)]);
    assert_eq!(after, [(wake + 5 * MIN, offline(1, wake))]);
}

#[test]
fn observations_that_do_not_count_freeze_and_clear_the_count_silently() {
    let mut w = watch();
    let notices = run(&mut w, 0, 20 * MIN, |t| {
        if (4 * MIN..8 * MIN).contains(&t) {
            // This Mac lost its network, or the host's agent is updating.
            vec![uncounted(1, false)]
        } else {
            vec![seen(1, false)]
        }
    });
    // 4 counted minutes before, none during; the count starts again at 8 min.
    assert_eq!(notices, [(13 * MIN, offline(1, 8 * MIN))]);
}

#[test]
fn a_host_removed_while_offline_is_forgotten_without_a_back() {
    let mut w = watch();
    let notices = run(&mut w, 0, 30 * MIN, |t| match t {
        t if t < 10 * MIN => vec![seen(1, false)],
        t if t < 20 * MIN => vec![],
        // Saved again later and reachable: nothing to report.
        _ => vec![seen(1, true)],
    });
    assert_eq!(notices, [(5 * MIN, offline(1, 0))]);
}

#[test]
fn a_host_first_seen_unreachable_at_launch_still_needs_five_observed_minutes() {
    let mut w = watch();
    let launch = 1_800_000_000_000;
    let notices = run(&mut w, launch, launch + 4 * MIN + STEP, |_| {
        vec![seen(1, false)]
    });
    assert_eq!(notices, []);
    let next = w.observe(launch + 5 * MIN, &[seen(1, false)]);
    assert_eq!(next, [offline(1, launch)]);
}

#[test]
fn two_hosts_are_tracked_separately() {
    let mut w = watch();
    let notices = run(&mut w, 0, 20 * MIN, |t| {
        vec![seen(1, (10 * MIN..).contains(&t)), seen(2, t < 2 * MIN)]
    });
    assert_eq!(
        notices,
        [
            (5 * MIN, offline(1, 0)),
            (7 * MIN, offline(2, 2 * MIN)),
            (10 * MIN, back(1, 0, 10 * MIN)),
        ]
    );
}

#[test]
fn reset_forgets_every_host() {
    let mut w = watch();
    // Host 1 is reported offline, host 2 is three minutes into its count.
    let before = run(&mut w, 0, 6 * MIN, |t| {
        vec![seen(1, false), seen(2, t < 3 * MIN)]
    });
    assert_eq!(before, [(5 * MIN, offline(1, 0))]);
    // Switched off and on again.
    w.reset();
    let start = 7 * MIN;
    let after = run(&mut w, start, start + 10 * MIN, |t| {
        vec![seen(1, t >= start + MIN), seen(2, false)]
    });
    // Host 1 coming back is no news after a reset; host 2 starts a fresh count.
    assert_eq!(after, [(start + 5 * MIN, offline(2, start))]);
}
