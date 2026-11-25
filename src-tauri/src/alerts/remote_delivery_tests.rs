use std::cell::RefCell;
use std::os::unix::fs::PermissionsExt;

use statglass_notify::{AlertText, Message};
use statglass_schema::settings::Settings;
use statglass_schema::{
    AlertCause, Cmp, Destination, DestinationKind, EventDetail, Labels, MetricId,
};

use super::*;
use crate::alerts::AlertsService;
use crate::alerts::fire::announce_catch_up;

const HOST: HostId = HostId(Uuid::from_u128(1));
const EPOCH: Uuid = Uuid::from_u128(2);
const MIRROR_EPOCH: Uuid = Uuid::from_u128(7);
const START: i64 = 1_800_000_000_000;

#[derive(Debug, PartialEq, Eq)]
enum Step {
    Notify(i64),
    Deliver(i64),
    Publish(i64),
    CatchUp(Vec<i64>),
}

#[derive(Default)]
struct Recorded(RefCell<Vec<Step>>);

impl AlertSinks for Recorded {
    fn record(&self, _: &Event) -> anyhow::Result<()> {
        panic!("a mirrored alert is already recorded");
    }

    fn notify(&self, event: &Event) {
        self.0.borrow_mut().push(Step::Notify(event.ts_ms));
    }

    fn deliver(&self, event: &Event) {
        self.0.borrow_mut().push(Step::Deliver(event.ts_ms));
    }

    fn publish(&self, event: &Event) {
        self.0.borrow_mut().push(Step::Publish(event.ts_ms));
    }
}

fn alert(ts_ms: i64) -> Event {
    Event {
        ts_ms,
        start_ms: ts_ms,
        processes: Vec::new(),
        detail: EventDetail::Alert {
            rule_id: Uuid::from_u128(6),
            rule_name: "CPU load average above 4".into(),
            cause: AlertCause::Threshold {
                metric: MetricId::from_static("cpu.loadavg"),
                labels: Labels::single("window", "5"),
                value: 5.0,
                op: Cmp::Gt,
                threshold: 4.0,
                for_secs: 0,
            },
        },
    }
}

fn receive_for(
    delivery: &RemoteDelivery,
    host: HostId,
    epoch: Uuid,
    now: i64,
    offset: Option<i64>,
    timestamps: &[i64],
) -> Vec<Step> {
    receive_in_mirror(delivery, host, epoch, MIRROR_EPOCH, now, offset, timestamps)
}

fn receive_in_mirror(
    delivery: &RemoteDelivery,
    host: HostId,
    epoch: Uuid,
    mirror_epoch: Uuid,
    now: i64,
    offset: Option<i64>,
    timestamps: &[i64],
) -> Vec<Step> {
    let sinks = Recorded::default();
    let events: Vec<_> = timestamps.iter().copied().map(alert).collect();
    delivery.receive(
        Batch {
            host,
            epoch,
            mirror_epoch,
            events: &events,
        },
        now,
        offset,
        &sinks,
        |late| {
            sinks.0.borrow_mut().push(Step::CatchUp(
                late.iter().map(|event| event.ts_ms).collect(),
            ));
        },
    );
    sinks.0.into_inner()
}

fn receive(delivery: &RemoteDelivery, now: i64, timestamps: &[i64]) -> Vec<Step> {
    receive_for(delivery, HOST, EPOCH, now, None, timestamps)
}

#[test]
fn first_batch_and_back_history_only_publish_for_each_host_and_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let delivery = RemoteDelivery::open(dir.path());
    let other_host = HostId(Uuid::from_u128(3));
    let new_epoch = Uuid::from_u128(4);
    let historical = START - 1;
    let future = START + 1;
    assert_eq!(
        receive(&delivery, START, &[historical, future]),
        [Step::Publish(historical), Step::Publish(future)]
    );
    assert_eq!(
        receive_for(&delivery, other_host, EPOCH, future, None, &[future]),
        [Step::Publish(future)]
    );
    assert_eq!(
        receive_for(&delivery, HOST, new_epoch, future, None, &[future]),
        [Step::Publish(future)]
    );
    assert_eq!(
        receive(&delivery, future, &[historical, START]),
        [
            Step::Publish(historical),
            Step::Notify(START),
            Step::Deliver(START),
            Step::Publish(START)
        ]
    );
}

#[test]
fn fresh_alerts_are_individual_and_late_alerts_share_one_catch_up() {
    let dir = tempfile::tempdir().unwrap();
    let delivery = RemoteDelivery::open(dir.path());
    receive(&delivery, START, &[START - 1]);
    let boundary = START + FRESH_MS;
    let now = boundary + FRESH_MS;
    let stale = boundary - 1;
    assert_eq!(
        receive(&delivery, now, &[START, boundary, stale, now]),
        [
            Step::Publish(START),
            Step::Notify(boundary),
            Step::Deliver(boundary),
            Step::Publish(boundary),
            Step::Publish(stale),
            Step::Notify(now),
            Step::Deliver(now),
            Step::Publish(now),
            Step::CatchUp(vec![START, stale])
        ]
    );
}

#[test]
fn a_batch_of_only_late_alerts_has_one_catch_up() {
    let dir = tempfile::tempdir().unwrap();
    let delivery = RemoteDelivery::open(dir.path());
    receive(&delivery, START, &[START - 1]);
    let late = START + 30_000;
    assert_eq!(
        receive(&delivery, late + FRESH_MS + 1, &[START, late]),
        [
            Step::Publish(START),
            Step::Publish(late),
            Step::CatchUp(vec![START, late])
        ]
    );
}

#[test]
fn clocks_two_hours_ahead_or_behind_preserve_the_floor_and_freshness() {
    for offset in [-7_200_000, 7_200_000] {
        let dir = tempfile::tempdir().unwrap();
        let delivery = RemoteDelivery::open(dir.path());
        let back = START - 1 + offset;
        let stale = START + offset;
        let now = START + FRESH_MS + 1;
        let fresh = now + offset;
        receive_for(&delivery, HOST, EPOCH, START, Some(offset), &[back - 1]);
        assert_eq!(
            receive_for(
                &delivery,
                HOST,
                EPOCH,
                now,
                Some(offset),
                &[back, stale, fresh],
            ),
            [
                Step::Publish(back),
                Step::Publish(stale),
                Step::Notify(fresh),
                Step::Deliver(fresh),
                Step::Publish(fresh),
                Step::CatchUp(vec![stale])
            ]
        );
    }
}

#[test]
fn floors_survive_reload_in_a_private_file() {
    let dir = tempfile::tempdir().unwrap();
    let delivery = RemoteDelivery::open(dir.path());
    receive(&delivery, START, &[START - 2]);
    let other = Uuid::from_u128(5);
    receive_for(&delivery, HOST, other, START + 1, None, &[START - 2]);
    drop(delivery);

    let path = dir.path().join(FLOORS_FILE);
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let delivery = RemoteDelivery::open(dir.path());
    let now = START + 2;
    assert_eq!(
        receive(&delivery, now, &[START - 1, START]),
        [
            Step::Publish(START - 1),
            Step::Notify(START),
            Step::Deliver(START),
            Step::Publish(START)
        ]
    );
    assert_eq!(
        receive_for(&delivery, HOST, other, now, None, &[START, START + 1]),
        [
            Step::Publish(START),
            Step::Notify(START + 1),
            Step::Deliver(START + 1),
            Step::Publish(START + 1)
        ]
    );
}

#[test]
fn rebuilding_a_mirror_keeps_replayed_alerts_in_the_timeline() {
    let dir = tempfile::tempdir().unwrap();
    let mirror_dir = dir.path().join("mirror");
    let delivery = RemoteDelivery::open(dir.path());
    let receive = |delivery: &RemoteDelivery, now, timestamp| {
        fs::create_dir_all(&mirror_dir).unwrap();
        let history = crate::history::History::open(&mirror_dir);
        let mirror_epoch = history.read(|reader| Ok(reader.epoch())).unwrap();
        history.close();
        receive_in_mirror(delivery, HOST, EPOCH, mirror_epoch, now, None, &[timestamp])
    };
    assert_eq!(
        receive(&delivery, START, START - 1),
        [Step::Publish(START - 1)]
    );
    let sent = START + 1;
    assert_eq!(
        receive(&delivery, sent, sent),
        [Step::Notify(sent), Step::Deliver(sent), Step::Publish(sent)]
    );

    drop(delivery);
    fs::remove_dir_all(&mirror_dir).unwrap();
    let delivery = RemoteDelivery::open(dir.path());
    assert_eq!(receive(&delivery, sent + 1, sent), [Step::Publish(sent)]);
    let new = sent + 2;
    assert_eq!(
        receive(&delivery, new, new),
        [Step::Notify(new), Step::Deliver(new), Step::Publish(new)]
    );
}

#[test]
fn a_floor_is_saved_on_the_next_batch_after_a_write_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FLOORS_FILE);
    let delivery = RemoteDelivery::open(dir.path());
    fs::create_dir(&path).unwrap();
    let log = capture_floor_log(|| {
        assert_eq!(
            receive(&delivery, START, &[START - 1]),
            [Step::Publish(START - 1)]
        );
    });
    assert!(log.contains("saving remote alert floors"), "{log}");
    fs::remove_dir(&path).unwrap();
    let fresh = START + 1;
    assert_eq!(
        receive(&delivery, fresh, &[fresh]),
        [
            Step::Notify(fresh),
            Step::Deliver(fresh),
            Step::Publish(fresh)
        ]
    );
    drop(delivery);

    // A pending alert may precede the successful retry. Keep the original floor.
    let delivery = RemoteDelivery::open(dir.path());
    assert_eq!(
        receive(&delivery, fresh + 1, &[START]),
        [
            Step::Notify(START),
            Step::Deliver(START),
            Step::Publish(START)
        ]
    );
}

fn capture_floor_log(run: impl FnOnce()) -> String {
    // Both failure scenarios exercise the same tracing callsite and interest cache.
    static CAPTURE: Mutex<()> = Mutex::new(());
    let _guard = CAPTURE.lock_ok();

    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Vec<u8>>>);

    impl Write for Log {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock_ok().write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let log = Log::default();
    let writer = log.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, run);
    String::from_utf8(log.0.lock_ok().clone()).unwrap()
}

#[test]
fn unreadable_and_corrupt_files_warn_and_start_fresh() {
    for unreadable in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FLOORS_FILE);
        let detail = if unreadable {
            fs::create_dir(&path).unwrap();
            "reading the floor file"
        } else {
            fs::write(&path, b"{").unwrap();
            "decoding the floor file"
        };
        let log = capture_floor_log(|| {
            let delivery = RemoteDelivery::open(dir.path());
            assert_eq!(
                receive(&delivery, START, &[START - 2]),
                [Step::Publish(START - 2)]
            );
            assert_eq!(
                receive(&delivery, START + 1, &[START - 1, START]),
                [
                    Step::Publish(START - 1),
                    Step::Notify(START),
                    Step::Deliver(START),
                    Step::Publish(START)
                ]
            );
        });
        assert!(
            log.lines().any(|line| line.contains("WARN")
                && line.contains("loading remote alert floors")
                && line.contains(detail)),
            "{log}"
        );
        if unreadable {
            assert!(log.contains("saving remote alert floors"), "{log}");
        } else {
            assert!(read_floors(&path).unwrap().contains_key(&HOST));
        }
    }
}

#[test]
fn only_linux_registration_creates_a_listener_and_it_forwards_the_batch() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let capture = received.clone();
    let linux = listener_for_host(true, move |epoch, events| {
        capture.lock_ok().push((epoch, events));
    })
    .unwrap();
    assert!(listener_for_host(false, |_, _| {}).is_none());
    let events = vec![alert(START), alert(START + 1)];
    linux(EPOCH, events.clone());
    assert_eq!(*received.lock_ok(), [(EPOCH, events)]);
}

#[test]
fn one_catch_up_notice_and_message_reach_each_sink() {
    let dir = tempfile::tempdir().unwrap();
    let alerts = AlertsService::open(dir.path());
    let destination = |n, enabled| Destination {
        id: Uuid::from_u128(n),
        name: format!("Destination {n}"),
        enabled,
        kind: DestinationKind::Webhook {
            url: format!("https://example.com/{n}"),
        },
    };
    let first = destination(1, true);
    let disabled = destination(2, false);
    let last = destination(3, true);
    for dest in [&first, &disabled, &last] {
        alerts.save(dest.clone()).unwrap();
    }
    let events = [alert(START + 1), alert(START)];
    let units = Settings::default().units;
    let expected = AlertText {
        title: "Alerts from m1-linux".into(),
        body: "While this Mac was away, m1-linux raised 2 alerts: CPU load average above 4 \
               and CPU load average above 4"
            .into(),
        rule: None,
        kind: "catch_up",
    };
    let message = Message::from_alert_text(expected.clone(), "m1-linux", START + 1);
    let notifications = RefCell::new(Vec::new());
    let sent = RefCell::new(Vec::new());
    receive(&alerts.remote_delivery, START, &[START - 1]);
    alerts.remote_delivery.receive(
        Batch {
            host: HOST,
            epoch: EPOCH,
            mirror_epoch: MIRROR_EPOCH,
            events: &events,
        },
        START + 2 + FRESH_MS,
        None,
        &Recorded::default(),
        |late| {
            announce_catch_up(
                &alerts,
                "m1-linux",
                &units,
                late,
                |text| notifications.borrow_mut().push(text),
                |dest, msg| sent.borrow_mut().push((dest, msg)),
            );
        },
    );
    assert_eq!(notifications.into_inner(), [expected]);
    assert_eq!(
        sent.into_inner(),
        [(first, message.clone()), (last, message)]
    );
}
