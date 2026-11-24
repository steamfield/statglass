//! Cases `src-tauri/src/alerts_tests.rs` leaves out: a bad file that cannot be moved
//! aside, saves and deletes racing on two threads, records and address changes,
//! [`AlertsService::deliver_to`], and that no error, log line or `Debug` output names a
//! destination's secrets. Real temp directories throughout.

use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Barrier, Mutex};

use statglass_notify::Message;
use statglass_schema::{
    DeliveryFailure, DeliveryOutcome, DeliveryRecord, Destination, DestinationKind,
};
use uuid::Uuid;

use super::store::{BAD_FILE, DESTINATIONS_FILE};
use super::{AlertsService, send_test};
use crate::error::CommandError;

const SERVER_SECRET: &str = "ntfy-host-zq81.example.net";
const TOPIC_SECRET: &str = "topic_zq81_secret";
const TOKEN_SECRET: &str = "tk_zq81_secret_token";
const WEBHOOK_SECRET: &str = "hooks-zq81-secret-path";
const SECRETS: [&str; 4] = [SERVER_SECRET, TOPIC_SECRET, TOKEN_SECRET, WEBHOOK_SECRET];

fn ntfy(n: u128) -> Destination {
    Destination {
        id: Uuid::from_u128(0x5ec0 + n),
        name: format!("Phone {n}"),
        enabled: true,
        kind: DestinationKind::Ntfy {
            server: format!("https://{SERVER_SECRET}"),
            topic: TOPIC_SECRET.into(),
            token: Some(TOKEN_SECRET.into()),
        },
    }
}

fn webhook(n: u128) -> Destination {
    Destination {
        id: Uuid::from_u128(0x5ec0 + n),
        name: format!("Chat {n}"),
        enabled: true,
        kind: DestinationKind::Webhook {
            url: format!("https://chat.example.com/{WEBHOOK_SECRET}"),
        },
    }
}

fn delivered(at_ms: i64) -> DeliveryRecord {
    DeliveryRecord {
        at_ms,
        outcome: DeliveryOutcome::Delivered { status: 204 },
    }
}

fn failed(at_ms: i64) -> DeliveryRecord {
    DeliveryRecord {
        at_ms,
        outcome: DeliveryOutcome::Failed {
            reason: DeliveryFailure::Http,
            detail: "HTTP 403".into(),
        },
    }
}

fn test_message() -> Message {
    Message {
        title: "Memory pressure 84%".into(),
        body: "Above 80% for 2 min".into(),
        host: "Studio".into(),
        rule: Some("Memory is tight".into()),
        kind: "threshold".into(),
        fired_at_ms: 1,
    }
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn assert_no_secret(text: &str) {
    for secret in SECRETS {
        assert!(!text.contains(secret), "{secret:?} leaked into {text:?}");
    }
}

#[test]
fn a_bad_file_that_cannot_be_moved_aside_is_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let garbage = b"{ not json";
    std::fs::write(dir.path().join(DESTINATIONS_FILE), garbage).unwrap();
    // A non-empty directory at the .bad name makes the rename fail.
    std::fs::create_dir(dir.path().join(BAD_FILE)).unwrap();
    std::fs::write(dir.path().join(BAD_FILE).join("keep"), b"").unwrap();

    let service = AlertsService::open(dir.path());
    let message = service.view().load_error.expect("load_error is set");
    assert!(
        message.contains("moving it to") && message.contains("left in place"),
        "{message}"
    );

    let refused = service.save(ntfy(1));
    assert!(
        matches!(&refused, Err(CommandError::SettingsNotSaved { message }) if message.contains(BAD_FILE)),
        "{refused:?}"
    );
    assert_eq!(
        std::fs::read(dir.path().join(DESTINATIONS_FILE)).unwrap(),
        garbage
    );
    assert!(service.view().destinations.is_empty());

    // Once the way is clear, the next save moves the bad file first.
    std::fs::remove_dir_all(dir.path().join(BAD_FILE)).unwrap();
    let view = service.save(ntfy(1)).unwrap();
    assert_eq!(view.destinations.len(), 1);
    let message = view.load_error.expect("load_error is kept");
    assert!(
        message.ends_with(&format!("it was moved to {BAD_FILE}")),
        "{message}"
    );
    assert_eq!(std::fs::read(dir.path().join(BAD_FILE)).unwrap(), garbage);
    assert_eq!(AlertsService::open(dir.path()).view().destinations.len(), 1);
}

#[test]
fn a_bad_file_the_user_removed_no_longer_blocks_saving() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(DESTINATIONS_FILE), b"{ not json").unwrap();
    std::fs::create_dir(dir.path().join(BAD_FILE)).unwrap();
    std::fs::write(dir.path().join(BAD_FILE).join("keep"), b"").unwrap();
    let service = AlertsService::open(dir.path());
    assert!(service.view().load_error.is_some());

    std::fs::remove_file(dir.path().join(DESTINATIONS_FILE)).unwrap();
    let view = service.save(ntfy(1)).unwrap();
    assert_eq!(view.destinations.len(), 1);
    assert_eq!(view.load_error, None, "nothing is left to report");
    assert!(dir.path().join(BAD_FILE).join("keep").exists());
    assert_eq!(AlertsService::open(dir.path()).view(), view);
}

#[test]
fn a_save_racing_a_delete_keeps_memory_and_file_in_step() {
    for round in 0..40 {
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(AlertsService::open(dir.path()));
        let (kept, doomed, added) = (ntfy(1), webhook(2), ntfy(3));
        service.save(kept.clone()).unwrap();
        service.save(doomed.clone()).unwrap();

        let start = Arc::new(Barrier::new(2));
        let saver = {
            let (service, start, added) = (service.clone(), start.clone(), added.clone());
            std::thread::spawn(move || {
                start.wait();
                service.save(added).unwrap();
            })
        };
        let deleter = {
            let (service, start, id) = (service.clone(), start.clone(), doomed.id);
            std::thread::spawn(move || {
                start.wait();
                service.delete(id).unwrap();
            })
        };
        saver.join().unwrap();
        deleter.join().unwrap();

        let ids: Vec<Uuid> = service
            .view()
            .destinations
            .iter()
            .map(|d| d.destination.id)
            .collect();
        assert_eq!(ids, [kept.id, added.id], "round {round}");
        assert_eq!(
            AlertsService::open(dir.path()).view(),
            service.view(),
            "round {round}: the file and memory disagree"
        );
    }
}

#[test]
fn a_record_lasts_while_the_address_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let d = webhook(1);
    service.save(d.clone()).unwrap();

    assert!(service.record(&d, failed(2_000)).is_some());
    let renamed_and_off = Destination {
        name: "Renamed".into(),
        enabled: false,
        ..d.clone()
    };
    let view = service.save(renamed_and_off).unwrap();
    assert_eq!(view.destinations[0].last, Some(failed(2_000)));

    // A corrected URL starts clean, and an outcome still in flight for the old URL
    // does not land on it.
    let moved = Destination {
        kind: DestinationKind::Webhook {
            url: "https://chat.example.com/fixed".into(),
        },
        ..d.clone()
    };
    assert_eq!(
        service.save(moved.clone()).unwrap().destinations[0].last,
        None
    );
    assert_eq!(service.record(&d, failed(3_000)), None);
    assert_eq!(service.view().destinations[0].last, None);
    assert!(service.record(&moved, delivered(4_000)).is_some());

    // A destination deleted and added again starts with no record.
    service.delete(d.id).unwrap();
    let view = service.save(moved).unwrap();
    assert_eq!(view.destinations[0].last, None);
}

#[test]
fn deliver_to_records_the_outcome_at_the_time_it_finished() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let d = ntfy(1);
    service.save(d.clone()).unwrap();
    let message = test_message();

    let seen = Mutex::new(None);
    let view = service.deliver_to(
        &d,
        &message,
        |dest, msg| {
            *seen.lock().unwrap() = Some((dest.clone(), msg.clone()));
            failed(0).outcome
        },
        || 7_000,
    );
    assert_eq!(
        seen.into_inner().unwrap(),
        Some((d.clone(), message.clone()))
    );
    let view = view.expect("recorded");
    assert_eq!(view.destinations[0].last, Some(failed(7_000)));
    assert_eq!(service.view(), view);
}

#[test]
fn deliver_to_drops_an_outcome_for_a_deleted_or_moved_destination() {
    let dir = tempfile::tempdir().unwrap();
    let service = AlertsService::open(dir.path());
    let (gone, moving) = (ntfy(1), webhook(2));
    service.save(gone.clone()).unwrap();
    service.save(moving.clone()).unwrap();
    let message = test_message();

    let after_delete = service.deliver_to(
        &gone,
        &message,
        |_, _| {
            service.delete(gone.id).unwrap();
            delivered(0).outcome
        },
        || 1,
    );
    assert_eq!(after_delete, None);

    let moved = Destination {
        kind: DestinationKind::Webhook {
            url: "https://chat.example.com/elsewhere".into(),
        },
        ..moving.clone()
    };
    let after_move = service.deliver_to(
        &moving,
        &message,
        |_, _| {
            service.save(moved.clone()).unwrap();
            delivered(0).outcome
        },
        || 1,
    );
    assert_eq!(after_move, None);
    assert_eq!(service.view().destinations[0].last, None);
}

/// Collects every log line written while `f` runs.
fn logged(f: impl FnOnce()) -> String {
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let sink = Sink::default();
    let writer = sink.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, f);
    String::from_utf8(sink.0.lock().unwrap().clone()).unwrap()
}

#[test]
fn no_error_log_or_debug_output_names_a_secret() {
    let dir = tempfile::tempdir().unwrap();
    let mut texts: Vec<String> = Vec::new();

    // A stored file whose decode error would quote a secret (a string where a bool
    // belongs), then one cut off right after the secrets.
    let wrong_type = format!(
        r#"{{"destinations":[{{"id":"{}","name":"x","enabled":"{TOKEN_SECRET}","kind":{{"type":"ntfy","server":"https://{SERVER_SECRET}","topic":"{TOPIC_SECRET}","token":"{TOKEN_SECRET}"}}}}]}}"#,
        Uuid::nil()
    );
    let cut_off = format!(
        r#"{{"destinations":[{{"kind":{{"type":"webhook","url":"https://x/{WEBHOOK_SECRET}"#
    );
    for contents in [wrong_type, cut_off] {
        std::fs::write(dir.path().join(DESTINATIONS_FILE), &contents).unwrap();
        let mut service = None;
        texts.push(logged(|| service = Some(AlertsService::open(dir.path()))));
        let load_error = service.unwrap().view().load_error.expect("load_error");
        assert!(load_error.contains("line 1"), "{load_error}");
        texts.push(load_error);
        std::fs::remove_file(dir.path().join(BAD_FILE)).unwrap();
    }

    let service = AlertsService::open(dir.path());
    for n in 1..=8 {
        service.save(ntfy(n)).unwrap();
    }
    let bad_token = Destination {
        kind: DestinationKind::Ntfy {
            server: format!("https://{SERVER_SECRET}"),
            topic: TOPIC_SECRET.into(),
            token: Some(format!("{TOKEN_SECRET} with space")),
        },
        ..ntfy(1)
    };
    let errors = [
        service.save(webhook(9)).unwrap_err(),
        service.save(bad_token.clone()).unwrap_err(),
        service.delete(Uuid::from_u128(0xdead)).unwrap_err(),
        send_test(bad_token, "Studio", 0, |_, _| unreachable!()).unwrap_err(),
    ];
    set_mode(dir.path(), 0o500);
    let not_saved = service.save(webhook(1)).unwrap_err();
    set_mode(dir.path(), 0o700);
    assert!(matches!(not_saved, CommandError::SettingsNotSaved { .. }));
    for error in errors.iter().chain([&not_saved]) {
        texts.push(error.to_string());
        texts.push(format!("{error:?}"));
    }

    // A failed delivery's log line, through the same path production uses.
    let message = test_message();
    texts.push(logged(|| {
        service.deliver_to(&ntfy(1), &message, |_, _| failed(0).outcome, || 5);
    }));
    assert!(
        texts
            .last()
            .is_some_and(|log| log.contains("alert delivery failed"))
    );
    texts.push(format!("{:?}", service.view()));
    for text in &texts {
        assert_no_secret(text);
    }
    // The checks above looked at real output.
    assert!(texts.iter().any(|t| t.contains("Phone 1")), "{texts:?}");
}
