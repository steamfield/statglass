use super::{PERIOD, Target};
use statglass_schema::HostId;
use std::{collections::BTreeMap, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Backoff(BTreeMap<HostId, Attempt>);

struct Attempt {
    generation: Uuid,
    failures: u8,
    next: Instant,
}

impl Backoff {
    pub(super) fn ready(&self, target: &Target) -> bool {
        self.0.get(&target.host).is_none_or(|attempt| {
            attempt.generation != target.generation
                || attempt.failures == 0
                || Instant::now() >= attempt.next
        })
    }

    /// Returns whether this was the first failure in the current connection.
    pub(super) fn record(&mut self, target: &Target, success: bool) -> bool {
        let attempt = self.0.entry(target.host).or_insert(Attempt {
            generation: target.generation,
            failures: 0,
            next: Instant::now(),
        });
        if attempt.generation != target.generation {
            attempt.generation = target.generation;
            attempt.failures = 0;
        }
        let first = attempt.failures == 0;
        attempt.failures = if success {
            0
        } else {
            (attempt.failures + 1).min(3)
        };
        let delay = match attempt.failures {
            0 => PERIOD,
            1 => Duration::from_secs(5 * 60),
            2 => Duration::from_secs(15 * 60),
            _ => Duration::from_secs(60 * 60),
        };
        attempt.next = Instant::now() + delay;
        first && !success
    }
}
