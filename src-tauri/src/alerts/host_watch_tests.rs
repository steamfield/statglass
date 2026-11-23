//! Remote statuses as the host-offline watch sees them, and its notices as the alert
//! events the store, the notifier and the destinations take.

use statglass_schema::{AlertCause, AlertRule, Event, EventDetail, HostId};
use uuid::Uuid;

use super::host_offline::{HostNotice, HostObservation, HostOfflineWatch};
use super::host_watch::{HOST_OFFLINE_RULE_NAME, notice_event, observation, poll};
use crate::remote::{
    AgentUpdateProgress, RemoteHostStatus, RemoteState, SavedHostStatus, UpdatePhase,
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
