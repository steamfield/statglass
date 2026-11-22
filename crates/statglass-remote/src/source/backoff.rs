//! How long a remote source waits between failed connection attempts. Pure.
use std::time::Duration;

/// The wait after the first failure.
const FIRST_WAIT: Duration = Duration::from_secs(1);
/// The longest wait between attempts.
const MAX_WAIT: Duration = Duration::from_secs(60);

/// The jitter added to each wait is below this many milliseconds.
const MAX_JITTER_MS: u64 = 250;

/// Exponential reconnect delay: 1 s after the first failure, doubling to 60 s.
#[derive(Clone, Debug, Default)]
pub(super) struct Backoff {
    failures: u32,
}

impl Backoff {
    /// A backoff with no failures recorded.
    pub(super) fn new() -> Self {
        Self::default()
    }

    /// Records a failed attempt and returns how long to wait before the next one
    /// (without jitter, which the caller adds).
    pub(super) fn fail(&mut self) -> Duration {
        let doublings = self.failures.min(MAX_WAIT.as_secs().ilog2() + 1);
        self.failures = self.failures.saturating_add(1);
        FIRST_WAIT.saturating_mul(1 << doublings).min(MAX_WAIT)
    }

    /// Schedules the attempt after a failure at wall time `now_ms`: the wait with up to
    /// 250 ms of jitter (derived from `now_ms` so hosts don't redial in step) and the
    /// wall time it ends. `None` when `offline`, which waits for the network instead
    /// and does not count toward the doubling.
    pub(super) fn next_wait(&mut self, offline: bool, now_ms: i64) -> Option<(Duration, i64)> {
        if offline {
            return None;
        }
        let jitter = Duration::from_millis(now_ms.unsigned_abs() % MAX_JITTER_MS);
        let wait = self.fail() + jitter;
        let wait_ms = i64::try_from(wait.as_millis()).unwrap_or(i64::MAX);
        Some((wait, now_ms.saturating_add(wait_ms)))
    }

    /// Forgets past failures after a connection succeeds or lasted long enough.
    pub(super) fn reset(&mut self) {
        self.failures = 0;
    }

    /// Failed attempts since the last reset.
    pub(super) fn attempt(&self) -> u32 {
        self.failures
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod next_wait_tests {
    use super::Backoff;
    use std::time::Duration;

    #[test]
    fn a_timed_wait_adds_jitter_from_the_clock_and_ends_at_wall_time() {
        let mut backoff = Backoff::new();
        let now_ms = 1_795_000_000_137;
        assert_eq!(
            backoff.next_wait(false, now_ms),
            Some((Duration::from_millis(1_137), now_ms + 1_137))
        );
        assert_eq!(
            backoff.next_wait(false, now_ms),
            Some((Duration::from_millis(2_137), now_ms + 2_137))
        );
        assert_eq!(backoff.attempt(), 2);
    }

    #[test]
    fn an_offline_wait_has_no_timer_and_keeps_the_doubling() {
        let mut backoff = Backoff::new();
        backoff.fail();
        assert_eq!(backoff.next_wait(true, 1_000), None);
        assert_eq!(backoff.attempt(), 1);
        assert_eq!(
            backoff.next_wait(false, 1_000),
            Some((Duration::from_secs(2), 3_000))
        );
    }
}
