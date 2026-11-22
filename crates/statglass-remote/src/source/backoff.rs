//! How long a remote source waits between failed connection attempts. Pure.
use std::time::Duration;

/// The wait after the first failure.
const FIRST_WAIT: Duration = Duration::from_secs(1);
/// The longest wait between attempts.
const MAX_WAIT: Duration = Duration::from_secs(60);

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
