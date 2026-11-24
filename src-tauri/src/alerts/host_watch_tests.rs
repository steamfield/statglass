//! Remote statuses as the host-offline watch sees them, and its notices as the alert
//! events the store, the notifier and the destinations take.

use statglass_schema::{AlertCause, AlertRule, Event, EventDetail, HostId};
use uuid::Uuid;

use super::host_offline::{HostNotice, HostObservation, HostOfflineWatch, ReportedHost};
use super::host_watch::{
    HOST_OFFLINE_RULE_NAME, SEED_LOOK_BACK_MS, notice_event, observation, poll, reported_hosts,
};
use crate::remote::{
    AgentUpdateProgress, RemoteFailureKind, RemoteHostStatus, RemoteState, SavedHostStatus,
    UpdatePhase,
};

const HOST: HostId = HostId(Uuid::from_u128(0xb0));
const NAME: &str = "m1-linux";

fn saved(status: RemoteHostStatus) -> SavedHostStatus {
    SavedHostStatus {
        host: HOST,
        name: NAME.into(),
        status,
    }
}

fn in_state(state: RemoteState) -> RemoteHostStatus {
    RemoteHostStatus {
        state,
        ..RemoteHostStatus::default()
    }
}

fn observed(reachable: bool, counts: bool) -> HostObservation {
    HostObservation {
        host: HOST,
        name: NAME.into(),
        reachable,
        counts,
    }
}

#[test]
fn each_connection_state_maps_to_reachable_and_counted() {
    let cases = [
        (RemoteState::Connected, observed(true, true)),
        (RemoteState::Connecting, observed(false, true)),
        (RemoteState::Offline, observed(false, true)),
        (RemoteState::Error, observed(false, true)),
        // The user switched the connection off: not this rule's business.
        (RemoteState::Disabled, observed(false, false)),
    ];
    for (state, expected) in cases {
        assert_eq!(
            observation(&saved(in_state(state.clone()))),
            expected,
            "{state:?}"
        );
    }
}

#[test]
fn a_mac_waiting_for_network_does_not_count() {
    let status = RemoteHostStatus {
        waiting_for_network: true,
        ..in_state(RemoteState::Offline)
    };
    assert_eq!(observation(&saved(status)), observed(false, false));
}

#[test]
fn a_failure_caused_by_this_mac_does_not_count() {
    for kind in [
        RemoteFailureKind::LocalOffline,
        RemoteFailureKind::TailscaleDown,
    ] {
        let status = RemoteHostStatus {
            failure_kind: Some(kind),
            ..in_state(RemoteState::Offline)
        };
        assert_eq!(
            observation(&saved(status)),
            observed(false, false),
            "{kind:?}"
        );
    }
}

#[test]
fn a_failure_on_the_host_side_still_counts() {
    let status = RemoteHostStatus {
        failure_kind: Some(RemoteFailureKind::Unreachable),
        ..in_state(RemoteState::Offline)
    };
    assert_eq!(observation(&saved(status)), observed(false, true));
}

#[test]
fn an_agent_update_in_progress_does_not_count() {
    let status = RemoteHostStatus {
        update: Some(AgentUpdateProgress {
            target: "0.14.0".into(),
            phase: UpdatePhase::Restarting,
        }),
        ..in_state(RemoteState::Offline)
    };
    assert_eq!(observation(&saved(status)), observed(false, false));
}

fn host_alert(ts_ms: i64, start_ms: i64, cause: AlertCause) -> Event {
    Event {
        ts_ms,
        start_ms,
        processes: vec![],
        detail: EventDetail::Alert {
            rule_id: AlertRule::HOST_OFFLINE_ID,
            rule_name: HOST_OFFLINE_RULE_NAME.into(),
            cause,
        },
    }
}

#[test]
fn an_offline_notice_is_a_host_offline_alert_from_when_the_host_was_first_unreachable() {
    let notice = HostNotice::Offline {
        host: HOST,
        name: NAME.into(),
        since_ms: 1_000_000,
    };
    assert_eq!(
        notice_event(notice, 1_300_000),
        host_alert(
            1_300_000,
            1_000_000,
            AlertCause::HostOffline {
                host: HOST,
                name: NAME.into()
            }
        )
    );
}

#[test]
fn a_back_notice_is_a_host_back_alert_with_its_offline_span_in_seconds() {
    let notice = HostNotice::Back {
        host: HOST,
        name: NAME.into(),
        since_ms: 9_000_000 - 2_520_400,
        offline_ms: 2_520_400,
    };
    assert_eq!(
        notice_event(notice, 9_000_000),
        host_alert(
            9_000_000,
            9_000_000 - 2_520_400,
            AlertCause::HostBack {
                host: HOST,
                name: NAME.into(),
                offline_secs: 2_520
            }
        )
    );
}

#[test]
fn a_poll_turns_five_offline_minutes_into_one_host_offline_alert() {
    let mut watch = HostOfflineWatch::new(300_000, 90_000);
    let hosts = [saved(in_state(RemoteState::Offline))];
    let mut events = Vec::new();
    for step in 0..=20 {
        events.extend(poll(&mut watch, step * 30_000, &hosts));
    }
    assert_eq!(
        events,
        [host_alert(
            300_000,
            0,
            AlertCause::HostOffline {
                host: HOST,
                name: NAME.into()
            }
        )]
    );
}

const OTHER: HostId = HostId(Uuid::from_u128(0xb1));

/// Polls `hosts_at(t)` every 30 s from 0 to `to_ms` inclusive and returns each event's
/// time and cause.
fn poll_every_30s(
    to_ms: i64,
    hosts_at: impl Fn(i64) -> Vec<SavedHostStatus>,
) -> Vec<(i64, AlertCause)> {
    let mut watch = HostOfflineWatch::new(300_000, 90_000);
    let mut seen = Vec::new();
    for now in (0..=to_ms).step_by(30_000) {
        for event in poll(&mut watch, now, &hosts_at(now)) {
            let EventDetail::Alert { cause, .. } = event.detail else {
                panic!("not an alert: {event:?}");
            };
            seen.push((event.ts_ms, cause));
        }
    }
    seen
}

fn named(host: HostId, name: &str, state: RemoteState) -> SavedHostStatus {
    SavedHostStatus {
        host,
        name: name.into(),
        status: in_state(state),
    }
}

#[test]
fn two_hosts_offline_on_one_poll_get_distinct_timestamps() {
    let events = poll_every_30s(300_000, |_| {
        vec![
            named(HOST, NAME, RemoteState::Offline),
            named(OTHER, "pi", RemoteState::Offline),
        ]
    });
    assert_eq!(
        events,
        [
            (
                300_000,
                AlertCause::HostOffline {
                    host: HOST,
                    name: NAME.into()
                }
            ),
            (
                300_001,
                AlertCause::HostOffline {
                    host: OTHER,
                    name: "pi".into()
                }
            ),
        ]
    );
}

#[test]
fn a_back_and_an_offline_on_one_poll_get_distinct_timestamps() {
    // HOST is down 0..10 min, OTHER from 5 min on: at 10 min one is back as the other
    // reaches five minutes.
    let events = poll_every_30s(600_000, |t| {
        let first = if t < 600_000 {
            RemoteState::Offline
        } else {
            RemoteState::Connected
        };
        let second = if t < 300_000 {
            RemoteState::Connected
        } else {
            RemoteState::Offline
        };
        vec![named(HOST, NAME, first), named(OTHER, "pi", second)]
    });
    assert_eq!(
        events,
        [
            (
                300_000,
                AlertCause::HostOffline {
                    host: HOST,
                    name: NAME.into()
                }
            ),
            (
                600_000,
                AlertCause::HostBack {
                    host: HOST,
                    name: NAME.into(),
                    offline_secs: 600
                }
            ),
            (
                600_001,
                AlertCause::HostOffline {
                    host: OTHER,
                    name: "pi".into()
                }
            ),
        ]
    );
}

// ---- seeds from stored alerts ------------------------------------------------------

const NOW: i64 = 1_791_158_400_000;
const HOUR: i64 = 3_600_000;

fn went_offline(host: HostId, ts_ms: i64, start_ms: i64) -> Event {
    host_alert(
        ts_ms,
        start_ms,
        AlertCause::HostOffline {
            host,
            name: NAME.into(),
        },
    )
}

fn came_back(host: HostId, ts_ms: i64, start_ms: i64) -> Event {
    host_alert(
        ts_ms,
        start_ms,
        AlertCause::HostBack {
            host,
            name: NAME.into(),
            offline_secs: 60,
        },
    )
}

#[test]
fn a_host_whose_newest_alert_is_offline_is_seeded_as_reported() {
    let stored = [
        went_offline(HOST, NOW - 30 * HOUR, NOW - 31 * HOUR),
        came_back(HOST, NOW - 29 * HOUR, NOW - 31 * HOUR),
        went_offline(HOST, NOW - 2 * HOUR, NOW - 3 * HOUR),
    ];
    assert_eq!(
        reported_hosts(&stored, &[HOST], NOW),
        [ReportedHost {
            host: HOST,
            since_ms: NOW - 3 * HOUR,
        }]
    );
}

#[test]
fn a_host_already_reported_back_is_not_seeded() {
    let stored = [
        came_back(HOST, NOW - HOUR, NOW - 3 * HOUR),
        went_offline(HOST, NOW - 2 * HOUR, NOW - 3 * HOUR),
    ];
    assert_eq!(reported_hosts(&stored, &[HOST], NOW), []);
}

#[test]
fn an_offline_alert_older_than_the_look_back_is_not_seeded() {
    let old = NOW - SEED_LOOK_BACK_MS - 1;
    let stored = [went_offline(HOST, old, old - HOUR)];
    assert_eq!(reported_hosts(&stored, &[HOST], NOW), []);
    let edge = NOW - SEED_LOOK_BACK_MS;
    let stored = [went_offline(HOST, edge, edge - HOUR)];
    assert_eq!(reported_hosts(&stored, &[HOST], NOW).len(), 1);
}

#[test]
fn only_saved_hosts_are_seeded_each_from_its_own_alerts() {
    let stored = [
        went_offline(HOST, NOW - 2 * HOUR, NOW - 3 * HOUR),
        went_offline(OTHER, NOW - HOUR, NOW - 2 * HOUR),
        came_back(OTHER, NOW - HOUR / 2, NOW - 2 * HOUR),
    ];
    assert_eq!(reported_hosts(&stored, &[OTHER], NOW), []);
    let hosts: Vec<HostId> = reported_hosts(&stored, &[HOST, OTHER], NOW)
        .iter()
        .map(|r| r.host)
        .collect();
    assert_eq!(hosts, [HOST]);
}

#[test]
fn other_rules_alerts_do_not_seed() {
    let mut foreign = went_offline(HOST, NOW - HOUR, NOW - 2 * HOUR);
    if let EventDetail::Alert { rule_id, .. } = &mut foreign.detail {
        *rule_id = AlertRule::BUILTIN_IDS[0];
    }
    assert_eq!(reported_hosts(&[foreign], &[HOST], NOW), []);
}
