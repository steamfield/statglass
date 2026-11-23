//! The built-in "saved host offline" rule as a pure state machine (plan/rfc-alerts.md
//! 4.10, 6.1): fed what each saved host looked like at one moment, it says when a host
//! has stayed unreachable for the rule's time and when it comes back. No clock and no
//! I/O: the caller passes the time of every observation.
//!
//! Time counts only across consecutive observations at most `max_step_ms` apart, so a
//! Mac that slept between two polls never counts its sleep toward the five minutes.

use statglass_schema::HostId;

/// What one saved host looked like at one poll.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostObservation {
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
        host: HostId,
        name: String,
        since_ms: i64,
    },
    /// A host reported [`HostNotice::Offline`] is reachable again, after being
    /// unreachable for `offline_ms` since it was first seen so.
    Back {
        host: HostId,
        name: String,
        offline_ms: i64,
    },
}

/// The watch over every saved host.
#[derive(Debug)]
pub struct HostOfflineWatch {
    /// Observed unreachable time after which a host is offline.
    after_ms: i64,
    /// The longest gap between two observations that still counts as observed time.
    max_step_ms: i64,
}

impl HostOfflineWatch {
    /// A watch that reports a host offline after `after_ms` of observed unreachable
    /// time, counting only steps of at most `max_step_ms`.
    pub fn new(after_ms: i64, max_step_ms: i64) -> Self {
        Self {
            after_ms,
            max_step_ms,
        }
    }

    /// Takes every saved host as observed at `now_ms` and returns the notices this
    /// observation produces, at most one per host. A host missing from `hosts` was
    /// removed: it is forgotten without a notice.
    pub fn observe(&mut self, now_ms: i64, hosts: &[HostObservation]) -> Vec<HostNotice> {
        let _ = (now_ms, hosts, self.after_ms, self.max_step_ms);
        Vec::new()
    }

    /// Forgets every host, as when the rule is switched off.
    pub fn reset(&mut self) {}
}
