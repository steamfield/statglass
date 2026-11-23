//! Glue between the remote hosts' statuses and [`HostOfflineWatch`]: a status becomes a
//! [`HostObservation`], a [`HostNotice`] becomes the alert [`Event`] the store, the
//! notifier and the destinations take. Thin; the rule itself is in
//! [`super::host_offline`].

use statglass_schema::{AlertCause, AlertRule, Event, EventDetail};

use super::host_offline::{HostNotice, HostObservation, HostOfflineWatch};
use crate::remote::{RemoteState, SavedHostStatus};

/// The `rule_name` of every host-offline alert.
pub const HOST_OFFLINE_RULE_NAME: &str = "Saved host offline";

/// What `saved` looks like to the watch: reachable while its session is connected;
/// not counted while its connection is switched off, an agent update is in progress,
/// or this Mac is waiting for a network.
pub fn observation(saved: &SavedHostStatus) -> HostObservation {
    let status = &saved.status;
    HostObservation {
        host: saved.host,
        name: saved.name.clone(),
        reachable: status.state == RemoteState::Connected,
        counts: status.state != RemoteState::Disabled
            && status.update.is_none()
            && !status.waiting_for_network,
    }
}

/// The alert event for `notice`, detected at `now_ms`: rule
/// [`statglass_schema::AlertRule::HOST_OFFLINE_ID`] named [`HOST_OFFLINE_RULE_NAME`],
/// cause [`AlertCause::HostOffline`] or [`AlertCause::HostBack`], `start_ms` the moment
/// the host was first seen unreachable, and no processes.
pub fn notice_event(notice: HostNotice, now_ms: i64) -> Event {
    let (start_ms, cause) = match notice {
        HostNotice::Offline {
            host,
            name,
            since_ms,
        } => (since_ms, AlertCause::HostOffline { host, name }),
        HostNotice::Back {
            host,
            name,
            offline_ms,
        } => (
            now_ms.saturating_sub(offline_ms),
            AlertCause::HostBack {
                host,
                name,
                offline_secs: whole_secs(offline_ms),
            },
        ),
    };
    Event {
        ts_ms: now_ms,
        start_ms,
        processes: Vec::new(),
        detail: EventDetail::Alert {
            rule_id: AlertRule::HOST_OFFLINE_ID,
            rule_name: HOST_OFFLINE_RULE_NAME.into(),
            cause,
        },
    }
}

/// `ms` in whole seconds, rounded down, within `u32`.
fn whole_secs(ms: i64) -> u32 {
    u32::try_from(ms.max(0) / 1000).unwrap_or(u32::MAX)
}

/// One poll: every saved host observed at `now_ms`, and the alert events the watch's
/// notices become.
pub fn poll(watch: &mut HostOfflineWatch, now_ms: i64, hosts: &[SavedHostStatus]) -> Vec<Event> {
    let observations: Vec<HostObservation> = hosts.iter().map(observation).collect();
    watch
        .observe(now_ms, &observations)
        .into_iter()
        .map(|notice| notice_event(notice, now_ms))
        .collect()
}
