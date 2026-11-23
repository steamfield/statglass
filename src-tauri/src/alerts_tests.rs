//! [`crate::alerts`]: the destinations file (plan/rfc-alerts.md 6.5) and sending alerts
//! to destinations, against a real temp directory and an injected send function. No
//! test touches the network or Tauri.

use std::path::Path;
use std::sync::Mutex;

use statglass_notify::{Message, alert_text};
use statglass_schema::{
    AlertCause, Cmp, DeliveryFailure, DeliveryOutcome, DeliveryRecord, Destination,
    DestinationError, DestinationKind, Event, EventDetail, Labels, MAX_DESTINATIONS, MetricId,
    Settings, ThermalState,
};
use uuid::Uuid;

use crate::alerts::{AlertDestinationsView, AlertsService, DestinationView, send_test};
use crate::error::CommandError;

const NOW: i64 = 1_800_000_000_000;
const FILE: &str = "alert-destinations.json";
const BAD_FILE: &str = "alert-destinations.json.bad";

fn ntfy(n: u128, enabled: bool) -> Destination {
    Destination {
        id: Uuid::from_u128(0xde50 + n),
        name: format!("Phone {n}"),
        enabled,
        kind: DestinationKind::Ntfy {
            server: "https://ntfy.sh".into(),
            topic: format!("statglass-topic-{n}"),
            token: Some(format!("tk_example_{n}")),
        },
    }
}

fn webhook(n: u128, enabled: bool) -> Destination {
    Destination {
        id: Uuid::from_u128(0xde50 + n),
        name: format!("Chat {n}"),
        enabled,
        kind: DestinationKind::Webhook {
            url: format!("https://chat.example.com/hooks/{n}"),
        },
    }
}

fn listed(destinations: &[Destination]) -> AlertDestinationsView {
    AlertDestinationsView {
        destinations: destinations
            .iter()
            .map(|d| DestinationView {
                destination: d.clone(),
                last: None,
            })
            .collect(),
        load_error: None,
    }
}

fn memory_alert() -> Event {
    Event {
        ts_ms: NOW,
        start_ms: NOW - 120_000,
        processes: vec![],
        detail: EventDetail::Alert {
            rule_id: Uuid::from_u128(0xa1e7),
            rule_name: "Memory is tight".into(),
            cause: AlertCause::Threshold {
                metric: MetricId::from_static("mem.pressure"),
                labels: Labels::new(),
                value: 84.0,
                op: Cmp::Gt,
                threshold: 80.0,
                for_secs: 120,
            },
        },
    }
}

fn delivered(at_ms: i64) -> DeliveryRecord {
    DeliveryRecord {
        at_ms,
        outcome: DeliveryOutcome::Delivered { status: 200 },
    }
}

fn failed(at_ms: i64, detail: &str) -> DeliveryRecord {
    DeliveryRecord {
        at_ms,
        outcome: DeliveryOutcome::Failed {
            reason: DeliveryFailure::Http,
            detail: detail.into(),
        },
    }
}

fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn names(view: &AlertDestinationsView) -> Vec<String> {
    view.destinations
        .iter()
        .map(|d| d.destination.name.clone())
        .collect()
}

// ---------------------------------------------------------------------------------------
// Store

#[test]
fn a_missing_file_is_an_empty_list_with_no_error() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    assert_eq!(service.view(), AlertDestinationsView::default());
    assert!(
        !dir.path().join(FILE).exists(),
        "opening wrote the file early"
    );
}

#[test]
fn saved_destinations_survive_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let first = ntfy(1, true);
    let second = webhook(2, false);
    assert_eq!(
        service.save(first.clone()).unwrap(),
        listed(std::slice::from_ref(&first))
    );
    let both = listed(&[first.clone(), second.clone()]);
    assert_eq!(service.save(second).unwrap(), both);
    assert_eq!(service.view(), both);

    let reopened = AlertsService::open(dir.path());
    assert_eq!(reopened.view(), both);

    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join(FILE)).unwrap()).unwrap();
    assert_eq!(
        raw["destinations"].as_array().map(Vec::len),
        Some(2),
        "{raw}"
    );
}

#[test]
fn the_destinations_file_is_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    service.save(ntfy(1, true)).unwrap();
    assert_eq!(mode(&dir.path().join(FILE)), 0o600);
    let leftovers: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(leftovers, [FILE], "a temp file was left behind");
}

#[test]
fn a_malformed_file_is_moved_aside_and_reported_once() {
    let dir = tempfile::tempdir().unwrap();
    let garbage = b"{\"destinations\": [ not json";
    std::fs::write(dir.path().join(FILE), garbage).unwrap();

    let service = AlertsService::open(dir.path());
    let view = service.view();
    assert!(view.destinations.is_empty());
    let message = view.load_error.expect("load_error is set");
    assert!(message.contains(BAD_FILE), "{message}");
    assert_eq!(std::fs::read(dir.path().join(BAD_FILE)).unwrap(), garbage);
    assert!(!dir.path().join(FILE).exists());

    // The next launch finds no file and nothing to report.
    assert_eq!(
        AlertsService::open(dir.path()).view(),
        AlertDestinationsView::default()
    );
}

#[test]
fn a_save_that_cannot_write_fails_and_keeps_the_list() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let kept = ntfy(1, true);
    service.save(kept.clone()).unwrap();

    set_mode(dir.path(), 0o500);
    let result = service.save(webhook(2, true));
    let deleted = service.delete(kept.id);
    set_mode(dir.path(), 0o700);

    assert!(
        matches!(result, Err(CommandError::SettingsNotSaved { .. })),
        "{result:?}"
    );
    assert!(
        matches!(deleted, Err(CommandError::SettingsNotSaved { .. })),
        "{deleted:?}"
    );
    assert_eq!(service.view(), listed(std::slice::from_ref(&kept)));
    assert_eq!(AlertsService::open(dir.path()).view(), listed(&[kept]));
}

#[test]
fn saving_an_existing_id_replaces_it_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let (a, b) = (ntfy(1, true), webhook(2, true));
    service.save(a.clone()).unwrap();
    service.save(b.clone()).unwrap();
    let renamed = Destination {
        name: "Renamed".into(),
        enabled: false,
        ..a
    };
    let view = service.save(renamed.clone()).unwrap();
    assert_eq!(view, listed(&[renamed.clone(), b.clone()]));
    assert_eq!(
        AlertsService::open(dir.path()).view(),
        listed(&[renamed, b])
    );
}

#[test]
fn a_ninth_destination_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let eight: Vec<Destination> = (1..=MAX_DESTINATIONS as u128)
        .map(|n| ntfy(n, true))
        .collect();
    for d in &eight {
        service.save(d.clone()).unwrap();
    }
    match service.save(ntfy(9, true)) {
        Err(CommandError::InvalidArgument { message }) => {
            assert!(message.contains('8'), "{message}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(service.view(), listed(&eight));
    // Replacing one of the eight is still allowed.
    let replaced = Destination {
        name: "Still eight".into(),
        ..eight[0].clone()
    };
    assert_eq!(service.save(replaced).unwrap().destinations.len(), 8);
}

#[test]
fn an_invalid_destination_is_rejected_with_its_reason() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let cases = [
        (
            Destination {
                name: "   ".into(),
                ..ntfy(1, true)
            },
            DestinationError::Name,
        ),
        (
            Destination {
                kind: DestinationKind::Webhook {
                    url: "file:///etc/hosts".into(),
                },
                ..webhook(2, true)
            },
            DestinationError::Url,
        ),
        (
            Destination {
                kind: DestinationKind::Ntfy {
                    server: "https://ntfy.sh".into(),
                    topic: "has space".into(),
                    token: None,
                },
                ..ntfy(3, true)
            },
            DestinationError::Topic,
        ),
    ];
    for (destination, reason) in cases {
        match service.save(destination) {
            Err(CommandError::InvalidArgument { message }) => {
                assert_eq!(message, reason.to_string());
            }
            other => panic!("{reason:?}: {other:?}"),
        }
    }
    assert_eq!(service.view(), AlertDestinationsView::default());
    assert!(!dir.path().join(FILE).exists());
}

#[test]
fn deleting_removes_a_destination_and_an_unknown_id_is_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let (a, b) = (ntfy(1, true), webhook(2, true));
    service.save(a.clone()).unwrap();
    service.save(b.clone()).unwrap();

    assert_eq!(
        service.delete(a.id).unwrap(),
        listed(std::slice::from_ref(&b))
    );
    assert_eq!(
        AlertsService::open(dir.path()).view(),
        listed(std::slice::from_ref(&b))
    );

    let unknown = service.delete(Uuid::from_u128(0xdead));
    assert!(
        matches!(unknown, Err(CommandError::InvalidArgument { .. })),
        "{unknown:?}"
    );
    assert!(
        matches!(
            service.delete(a.id),
            Err(CommandError::InvalidArgument { .. })
        ),
        "a deleted id is unknown"
    );
    assert_eq!(service.view(), listed(&[b]));
}

// ---------------------------------------------------------------------------------------
// Dispatch

/// A service in `dir` holding `destinations`, saved through the real path.
fn service_with(dir: &Path, destinations: &[Destination]) -> AlertsService {
    let service = AlertsService::open(dir);
    for d in destinations {
        service.save(d.clone()).unwrap();
    }
    service
}

#[test]
fn an_alert_goes_to_every_enabled_destination_and_no_disabled_one() {
    let dir = tempfile::tempdir().unwrap();
    let (on_a, off, on_b) = (ntfy(1, true), webhook(2, false), webhook(3, true));
    let service = service_with(dir.path(), &[on_a.clone(), off, on_b.clone()]);
    let units = Settings::default().units;
    let event = memory_alert();

    let sent = Mutex::new(Vec::new());
    service.on_alert(&event, "Studio", &units, |d, m| {
        sent.lock().unwrap().push((d, m));
    });

    let expected = Message::from_alert_text(alert_text(&event, &units).unwrap(), "Studio", NOW);
    let sent = sent.into_inner().unwrap();
    let mut ids: Vec<Uuid> = sent.iter().map(|(d, _)| d.id).collect();
    ids.sort();
    assert_eq!(ids, [on_a.id, on_b.id]);
    for (destination, message) in &sent {
        assert_eq!(message, &expected, "{:?}", destination.id);
        assert!(destination == &on_a || destination == &on_b);
    }
    assert_eq!(expected.kind, "threshold");
    assert_eq!(expected.rule.as_deref(), Some("Memory is tight"));
}

#[test]
fn each_outcome_is_recorded_with_its_time_and_emitted_once() {
    let dir = tempfile::tempdir().unwrap();
    let (a, off, b) = (ntfy(1, true), webhook(2, false), webhook(3, true));
    let service = service_with(dir.path(), &[a.clone(), off.clone(), b.clone()]);
    let outcome_for = |d: &Destination| {
        if d.id == a.id {
            delivered(NOW + 400)
        } else {
            failed(NOW + 900, "HTTP 403")
        }
    };

    let emitted = Mutex::new(Vec::new());
    service.on_alert(
        &memory_alert(),
        "Studio",
        &Settings::default().units,
        |d, _m| {
            if let Some(view) = service.record(&d, outcome_for(&d)) {
                emitted.lock().unwrap().push(view);
            }
        },
    );

    let emitted = emitted.into_inner().unwrap();
    assert_eq!(emitted.len(), 2, "one emit per finished delivery");
    let view = service.view();
    assert_eq!(emitted.last(), Some(&view));
    let last: Vec<Option<DeliveryRecord>> =
        view.destinations.iter().map(|d| d.last.clone()).collect();
    assert_eq!(
        last,
        [
            Some(delivered(NOW + 400)),
            None,
            Some(failed(NOW + 900, "HTTP 403"))
        ]
    );
    assert_eq!(names(&view), ["Phone 1", "Chat 2", "Chat 3"]);

    // An outcome for a destination deleted meanwhile changes nothing and emits nothing.
    assert_eq!(
        service.record(
            &Destination {
                id: Uuid::from_u128(0xdead),
                ..a.clone()
            },
            delivered(NOW)
        ),
        None
    );
    assert_eq!(service.view(), view);
}

#[test]
fn a_non_alert_event_sends_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let service = service_with(dir.path(), &[ntfy(1, true)]);
    let thermal_change = Event {
        ts_ms: NOW,
        start_ms: NOW,
        processes: vec![],
        detail: EventDetail::ThermalState {
            from: None,
            to: ThermalState::Serious,
        },
    };
    let sent = Mutex::new(0);
    service.on_alert(
        &thermal_change,
        "Studio",
        &Settings::default().units,
        |_, _| {
            *sent.lock().unwrap() += 1;
        },
    );
    assert_eq!(sent.into_inner().unwrap(), 0);

    // The same service does send a real alert, so the zero above is not vacuous.
    let sent = Mutex::new(0);
    service.on_alert(
        &memory_alert(),
        "Studio",
        &Settings::default().units,
        |_, _| {
            *sent.lock().unwrap() += 1;
        },
    );
    assert_eq!(sent.into_inner().unwrap(), 1);
}

#[test]
fn the_test_command_sends_to_the_given_destination_without_saving_it() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let unsaved = ntfy(1, true);

    let seen = Mutex::new(None);
    let outcome = send_test(unsaved.clone(), "Studio", NOW, |d, m| {
        *seen.lock().unwrap() = Some((d.clone(), m.clone()));
        DeliveryOutcome::Delivered { status: 200 }
    });
    assert_eq!(outcome, Ok(DeliveryOutcome::Delivered { status: 200 }));
    let (destination, message) = seen.into_inner().unwrap().expect("deliver was called");
    assert_eq!(destination, unsaved);
    assert_eq!(message.title, "Test from StatGlass on Studio");
    assert_eq!(message.host, "Studio");
    assert_eq!(message.rule, None);
    assert_eq!(message.fired_at_ms, NOW);
    assert!(!message.body.is_empty());

    // A failure comes back as it happened.
    let failure = DeliveryOutcome::Failed {
        reason: DeliveryFailure::TimedOut,
        detail: "Timed out after 10 s".into(),
    };
    assert_eq!(
        send_test(unsaved.clone(), "Studio", NOW, |_, _| failure.clone()),
        Ok(failure)
    );

    // Nothing was saved or recorded.
    assert_eq!(service.view(), AlertDestinationsView::default());
    assert!(!dir.path().join(FILE).exists());
}

#[test]
fn the_test_command_refuses_an_invalid_destination_without_sending() {
    let invalid = Destination {
        name: String::new(),
        ..ntfy(1, true)
    };
    let called = Mutex::new(false);
    let result = send_test(invalid, "Studio", NOW, |_, _| {
        *called.lock().unwrap() = true;
        DeliveryOutcome::Delivered { status: 200 }
    });
    match result {
        Err(CommandError::InvalidArgument { message }) => {
            assert_eq!(message, DestinationError::Name.to_string());
        }
        other => panic!("{other:?}"),
    }
    assert!(!called.into_inner().unwrap());
}

#[test]
fn records_land_in_arrival_order_even_when_the_clock_steps_back() {
    let dir = tempfile::tempdir().unwrap();
    let d = ntfy(1, true);
    let service = service_with(dir.path(), std::slice::from_ref(&d));

    let first = service.record(&d, failed(NOW + 2_000, "HTTP 500"));
    assert!(first.is_some());
    // The wall clock stepped back (an NTP step after wake): the later arrival still wins.
    let stepped_back = service.record(&d, delivered(NOW + 1_000));
    assert_eq!(
        stepped_back.map(|v| v.destinations[0].last.clone()),
        Some(Some(delivered(NOW + 1_000)))
    );
    assert_eq!(
        service.view().destinations[0].last,
        Some(delivered(NOW + 1_000))
    );

    let later = service.record(&d, delivered(NOW + 3_000));
    assert_eq!(
        later.map(|v| v.destinations[0].last.clone()),
        Some(Some(delivered(NOW + 3_000)))
    );
}
