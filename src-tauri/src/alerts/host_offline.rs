//! The built-in "saved host offline" rule as a pure state machine (plan/rfc-alerts.md
//! 4.10, 6.1): fed what each saved host looked like at one moment, it says when a host
//! has stayed unreachable for the rule's time and when it comes back. No clock and no
//! I/O: the caller passes the time of every observation.
//!
//! Time counts only across consecutive observations at most `max_step_ms` apart, so a
//! Mac that slept between two polls never counts its sleep toward the five minutes. A
//! longer step (or the clock going backwards) restarts every host's count. A host
//! already reported offline stays reported across such a step, so it still gets its
//! [`HostNotice::Back`] when it is reachable again.

use std::collections::BTreeMap;

use statglass_schema::HostId;

/// What one saved host looked like at one poll.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostObservation {
    /// The saved host.
    pub host: HostId,
    /// The host's name, carried into its notices.
    pub name: String,
    /// The host's session is connected.
    pub reachable: bool,
    /// Whether this observation may count toward the rule at all: false while the
    /// user has switched the host's connection off, an agent update is running, or
    /// this Mac has no network.
    pub counts: bool,
}

/// What the watch reports about one host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostNotice {
    /// The host has been unreachable for the rule's time, counted from `since_ms`,
    /// the observation it was first seen unreachable at.
    Offline {
        /// The saved host.
        host: HostId,
        /// Its name at this observation.
        name: String,
        /// When the unreachable run that reached the rule's time began.
        since_ms: i64,
    },
    /// A host reported [`HostNotice::Offline`] is reachable again, after being
    /// unreachable for `offline_ms` since it was first seen so.
    Back {
        /// The saved host.
        host: HostId,
        /// Its name at this observation, which may differ from the offline notice's.
        name: String,
        /// From the start of the reported run to this observation.
        offline_ms: i64,
    },
}

/// Where one host stands. A host that is reachable, or not counted and not reported,
/// has no entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Track {
    /// Unreachable since `since_ms`, not yet for the rule's time.
    Counting { since_ms: i64 },
    /// Reported offline; unreachable since `since_ms`.
    Reported { since_ms: i64 },
}

/// The watch over every saved host.
#[derive(Debug)]
pub struct HostOfflineWatch {
    /// Observed unreachable time after which a host is offline.
    after_ms: i64,
    /// The longest gap between two observations that still counts as observed time.
    max_step_ms: i64,
    /// When the previous observation was made, `None` before the first.
    last_ms: Option<i64>,
    hosts: BTreeMap<HostId, Track>,
}

impl HostOfflineWatch {
    /// A watch that reports a host offline after `after_ms` of observed unreachable
    /// time, counting only steps of at most `max_step_ms`.
    pub fn new(after_ms: i64, max_step_ms: i64) -> Self {
        Self {
            after_ms,
            max_step_ms,
            last_ms: None,
            hosts: BTreeMap::new(),
        }
    }

    /// Takes every saved host as observed at `now_ms` and returns the notices this
    /// observation produces, at most one per host. A host missing from `hosts` was
    /// removed: it is forgotten without a notice.
    pub fn observe(&mut self, now_ms: i64, hosts: &[HostObservation]) -> Vec<HostNotice> {
        let continuous = self
            .last_ms
            .is_some_and(|last| (0..=self.max_step_ms).contains(&now_ms.saturating_sub(last)));
        self.last_ms = Some(now_ms);
        self.hosts
            .retain(|id, _| hosts.iter().any(|seen| seen.host == *id));
        hosts
            .iter()
            .filter_map(|seen| {
                let before = self.hosts.get(&seen.host).copied();
                let (after, notice) = step(before, seen, now_ms, continuous, self.after_ms);
                match after {
                    Some(track) => self.hosts.insert(seen.host, track),
                    None => self.hosts.remove(&seen.host),
                };
                notice
            })
            .collect()
    }

    /// Forgets every host, as when the rule is switched off.
    pub fn reset(&mut self) {
        self.last_ms = None;
        self.hosts.clear();
    }
}

/// One host's move from `before` given `seen` at `now_ms`. `continuous` says whether
/// the time since the previous observation counts.
fn step(
    before: Option<Track>,
    seen: &HostObservation,
    now_ms: i64,
    continuous: bool,
    after_ms: i64,
) -> (Option<Track>, Option<HostNotice>) {
    if let Some(Track::Reported { since_ms }) = before {
        if seen.reachable && seen.counts {
            let back = HostNotice::Back {
                host: seen.host,
                name: seen.name.clone(),
                offline_ms: now_ms.saturating_sub(since_ms).max(0),
            };
            return (None, Some(back));
        }
        return (before, None);
    }
    if seen.reachable || !seen.counts {
        return (None, None);
    }
    let since_ms = match before {
        Some(Track::Counting { since_ms }) if continuous => since_ms,
        _ => now_ms,
    };
    if now_ms.saturating_sub(since_ms) < after_ms {
        return (Some(Track::Counting { since_ms }), None);
    }
    let offline = HostNotice::Offline {
        host: seen.host,
        name: seen.name.clone(),
        since_ms,
    };
    (Some(Track::Reported { since_ms }), Some(offline))
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    const MIN: i64 = 60_000;
    const HOST: HostId = HostId(Uuid::from_u128(7));

    fn seen(name: &str, reachable: bool, counts: bool) -> HostObservation {
        HostObservation {
            host: HOST,
            name: name.into(),
            reachable,
            counts,
        }
    }

    /// A watch on the production timings that has just reported `HOST` offline, with
    /// the unreachable run starting at 0 and the last observation at 5 minutes.
    fn reported() -> HostOfflineWatch {
        let mut watch = HostOfflineWatch::new(5 * MIN, 90_000);
        for step in 0..10 {
            assert_eq!(watch.observe(step * 30_000, &[seen("a", false, true)]), []);
        }
        let notices = watch.observe(5 * MIN, &[seen("a", false, true)]);
        assert_eq!(
            notices,
            [HostNotice::Offline {
                host: HOST,
                name: "a".into(),
                since_ms: 0
            }]
        );
        watch
    }

    #[test]
    fn a_reported_host_back_after_this_mac_slept_is_still_announced() {
        let mut watch = reported();
        let notices = watch.observe(60 * MIN, &[seen("a", true, true)]);
        assert_eq!(
            notices,
            [HostNotice::Back {
                host: HOST,
                name: "a".into(),
                offline_ms: 60 * MIN
            }]
        );
    }

    #[test]
    fn a_reported_host_still_unreachable_after_a_sleep_is_not_reported_again() {
        let mut watch = reported();
        assert_eq!(watch.observe(60 * MIN, &[seen("a", false, true)]), []);
        assert_eq!(watch.observe(70 * MIN, &[seen("a", false, true)]), []);
    }

    #[test]
    fn a_host_renamed_while_offline_comes_back_under_its_new_name() {
        let mut watch = reported();
        assert_eq!(
            watch.observe(5 * MIN + 30_000, &[seen("b", false, true)]),
            []
        );
        let notices = watch.observe(6 * MIN, &[seen("b", true, true)]);
        assert_eq!(
            notices,
            [HostNotice::Back {
                host: HOST,
                name: "b".into(),
                offline_ms: 6 * MIN
            }]
        );
    }

    #[test]
    fn a_reported_host_is_not_back_until_a_counted_observation_sees_it() {
        let mut watch = reported();
        // Connected but mid agent update: not this rule's business yet.
        assert_eq!(
            watch.observe(5 * MIN + 30_000, &[seen("a", true, false)]),
            []
        );
        let notices = watch.observe(6 * MIN, &[seen("a", true, true)]);
        assert_eq!(
            notices,
            [HostNotice::Back {
                host: HOST,
                name: "a".into(),
                offline_ms: 6 * MIN
            }]
        );
    }

    #[test]
    fn the_clock_going_backwards_restarts_the_count() {
        let mut watch = HostOfflineWatch::new(5 * MIN, 90_000);
        assert_eq!(watch.observe(10 * MIN, &[seen("a", false, true)]), []);
        let mut notices = Vec::new();
        for step in 0..=10 {
            notices.extend(watch.observe(4 * MIN + step * 30_000, &[seen("a", false, true)]));
        }
        assert_eq!(
            notices,
            [HostNotice::Offline {
                host: HOST,
                name: "a".into(),
                since_ms: 4 * MIN
            }]
        );
    }
}
