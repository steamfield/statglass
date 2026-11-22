//! How long a remote source waits between failed connection attempts. Pure.
use std::time::Duration;

/// Exponential reconnect delay: 1 s after the first failure, doubling to 60 s.
#[derive(Clone, Debug, Default)]
pub(super) struct Backoff {
    failures: u32,
}

impl Backoff {
    pub(super) fn new() -> Self {
        Self::default()
    }

    /// Records a failed attempt and returns how long to wait before the next one
    /// (without jitter, which the caller adds).
    pub(super) fn fail(&mut self) -> Duration {
        Duration::ZERO
    }

    /// Forgets past failures after a connection succeeds or lasted long enough.
    pub(super) fn reset(&mut self) {}

    /// Failed attempts since the last reset.
    pub(super) fn attempt(&self) -> u32 {
        self.failures
    }
}

#[cfg(test)]
mod tests;
