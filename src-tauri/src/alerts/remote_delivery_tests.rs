use std::cell::RefCell;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicI64, Ordering};

use statglass_notify::{AlertText, Message};
use statglass_proto::SyncPage;
use statglass_remote::MirrorSink;
use statglass_schema::settings::Settings;
use statglass_schema::{
    AlertCause, Cmp, Cursor, Destination, DestinationKind, EventDetail, HostInfo, Labels, MetricId,
    OsKind, SyncKinds, Tier,
};
use statglass_store::{Store, StoreConfig};
use tauri::{Listener, Manager};

use super::*;
use crate::alerts::AlertsService;
use crate::alerts::fire::announce_catch_up;
use crate::ipc::EventRecorded;

const HOST: HostId = HostId(Uuid::from_u128(1));
const GENERATION: Uuid = Uuid::from_u128(2);
const MIRROR_EPOCH: Uuid = Uuid::from_u128(7);
const START: i64 = 1_800_000_000_000;

#[derive(Default, Debug, PartialEq)]
struct Seen {
    posts: Vec<AlertText>,
    sends: Vec<(Destination, Message)>,
    timeline: Vec<serde_json::Value>,
}

struct Mirrored {
    app: tauri::App<tauri::test::MockRuntime>,
    host: HostRecord,
    history: Arc<History>,
    mirror: Mirror,
    source: Store,
    cursor: Option<Cursor>,
    now: Arc<AtomicI64>,
    seen: Arc<Mutex<Seen>>,
    destination: Destination,
    dir: tempfile::TempDir,
}

impl Mirrored {
    fn new(linux: bool, offset: i64) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let host = HostRecord {
            id: HOST,
            is_local: false,
            display_name: "m1-linux".into(),
            info: HostInfo {
                os: if linux { OsKind::Linux } else { OsKind::MacOs },
                os_version: String::new(),
                model: None,
                chip: None,
                chip_known: false,
                cpu_topology: vec![],
                mem_total_bytes: 0,
                boot_time_ms: 0,
                gpu_dvfs_mhz: vec![],
                boot_mounts: vec![],
                kernel: None,
            },
        };
        let seen = Arc::new(Mutex::new(Seen::default()));
        let app = Self::open_app(dir.path(), seen.clone());
        let alerts = app.state::<AlertsService>();
        let destination = Destination {
            id: Uuid::from_u128(8),
            name: "Webhook".into(),
            enabled: true,
            kind: DestinationKind::Webhook {
                url: "https://example.com/alerts".into(),
            },
        };
        alerts.save(destination.clone()).unwrap();
        alerts
            .save(Destination {
                id: Uuid::from_u128(9),
                enabled: false,
                ..destination.clone()
            })
            .unwrap();
        let history = Arc::new(History::open(dir.path()));
        history.register_host(&host).unwrap();
        let mirror = Mirror::new(history.store(), HOST, 100);
        let source = Self::open_source(dir.path(), &host, "source.sqlite");
        let fixture = Self {
            app,
            host,
            history,
            mirror,
            source,
            cursor: None,
            now: Arc::new(AtomicI64::new(START)),
            seen,
            destination,
            dir,
        };
        fixture.wire(linux, offset);
        fixture
    }

    fn open_app(dir: &Path, seen: Arc<Mutex<Seen>>) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events![EventRecorded])
            .mount_events(&app);
        app.manage(AlertsService::open(dir));
        app.manage(Mutex::new(BTreeMap::from([(HOST, GENERATION)])));
        app.listen("event-recorded", move |event| {
            seen.lock_ok()
                .timeline
                .push(serde_json::from_str(event.payload()).unwrap());
        });
        app
    }

    fn open_source(dir: &Path, host: &HostRecord, name: &str) -> Store {
        let source = Store::open(StoreConfig::new(dir.join(name))).unwrap();
        source.writer().upsert_host(host.clone()).unwrap();
        source
    }

    fn wire(&self, linux: bool, offset: i64) {
        let post = self.seen.clone();
        let send = self.seen.clone();
        let now = self.now.clone();
        wire_mirror_alerts(
            linux,
            &self.mirror,
            self.history.clone(),
            MirrorAlerts {
                app: self.app.handle().clone(),
                host: self.host.clone(),
                generation: GENERATION,
                generations: |app| app.state::<Mutex<BTreeMap<HostId, Uuid>>>().inner(),
                alerts: |app| app.state::<AlertsService>().inner(),
                units: |_| Settings::default().units,
                clock: Box::new(move || {
                    let now = now.load(Ordering::Relaxed);
                    (now, Some(now + offset))
                }),
                outputs: AlertOutputs {
                    post: Arc::new(move |text| post.lock_ok().posts.push(text)),
                    send: Arc::new(move |dest, message| send.lock_ok().sends.push((dest, message))),
                },
            },
        );
    }

    fn page(&mut self, events: &[Event], more: bool) -> SyncPage {
        let writer = self.source.writer();
        for event in events {
            writer.record_event(HOST, event).unwrap();
        }
        writer.flush().unwrap();
        let result = self
            .source
            .reader()
            .unwrap()
            .read_after(HOST, Tier::M1, self.cursor, 10, SyncKinds::ALL)
            .unwrap();
        let statglass_proto::Message::SyncPage(mut page) = statglass_remote::page_to_wire(result)
        else {
            panic!("source history page expected");
        };
        page.more = more;
        self.cursor = Some(Cursor {
            epoch: page.epoch,
            seq: page.last_seq,
        });
        page
    }

    fn ingest(&self, page: SyncPage) {
        self.mirror
            .cursor(page.tier, page.epoch, SyncKinds::ALL)
            .unwrap();
        self.mirror.ingest(page, SyncKinds::ALL).unwrap();
    }

    fn receive(&mut self, events: &[Event], more: bool) {
        let page = self.page(events, more);
        self.ingest(page);
    }

    fn take(&self) -> Seen {
        std::mem::take(&mut *self.seen.lock_ok())
    }

    fn forget(&self) {
        self.app
            .state::<AlertsService>()
            .remote_delivery
            .forget(HOST);
        assert!(
            !read_floors(&self.dir.path().join(FLOORS_FILE))
                .unwrap()
                .contains_key(&HOST)
        );
    }

    fn expected(&self, text: Option<AlertText>, time: i64, events: &[Event]) -> Seen {
        Seen {
            sends: text
                .iter()
                .map(|text| {
                    (
                        self.destination.clone(),
                        Message::from_alert_text(text.clone(), "m1-linux", time),
                    )
                })
                .collect(),
            posts: text.into_iter().collect(),
            timeline: events
                .iter()
                .map(|event| serde_json::json!({"host": HOST, "event": event}))
                .collect(),
        }
    }
}

fn single_text() -> AlertText {
    AlertText {
        title: "m1-linux: CPU load average above 4".into(),
        body: "Load average (5 min) 5 · above 4".into(),
        rule: Some("CPU load average above 4".into()),
        kind: "threshold",
    }
}

fn group_text(body: &str) -> AlertText {
    AlertText {
        title: "Alerts from m1-linux".into(),
        body: body.into(),
        rule: None,
        kind: "catch_up",
    }
}

#[test]
fn pending_late_alerts_survive_restart_and_are_sent_once_when_caught_up() {
    let offset = 7_200_000;
    let mut fixture = Mirrored::new(true, offset);
    fixture.now.store(START + FRESH_MS + 10, Ordering::Relaxed);
    let events = [alert(START + offset), alert(START + 1 + offset)];
    let page = fixture.page(&events, true);
    fixture.ingest(page.clone());
    assert_eq!(fixture.take(), fixture.expected(None, 0, &events));

    fixture.app = Mirrored::open_app(fixture.dir.path(), fixture.seen.clone());
    fixture.wire(true, -offset);
    fixture.ingest(page);
    assert_eq!(fixture.take(), Seen::default());
    fixture.receive(&[], false);
    assert_eq!(
        fixture.take(),
        fixture.expected(
            Some(group_text(
                "While this Mac was away, m1-linux raised 2 alerts: CPU load average above 4 (twice)",
            )),
            START + 1,
            &[]
        )
    );

    fixture.app = Mirrored::open_app(fixture.dir.path(), fixture.seen.clone());
    fixture.wire(true, 0);
    fixture.receive(&[], false);
    assert_eq!(fixture.take(), Seen::default());
}

#[test]
fn a_nonfinite_alert_does_not_poison_saved_catch_up() {
    let mut fixture = Mirrored::new(true, 0);
    fixture.now.store(START + FRESH_MS + 10, Ordering::Relaxed);
    let mut malformed = alert(START);
    let EventDetail::Alert {
        cause: AlertCause::Threshold { value, .. },
        ..
    } = &mut malformed.detail
    else {
        unreachable!()
    };
    *value = f32::INFINITY;
    let events = [malformed, alert(START + 1)];
    fixture.receive(&events, true);
    assert_eq!(fixture.take(), fixture.expected(None, 0, &events));

    fixture.app = Mirrored::open_app(fixture.dir.path(), fixture.seen.clone());
    fixture.wire(true, 0);
    fixture.receive(&[], false);
    assert_eq!(
        fixture.take(),
        fixture.expected(
            Some(group_text(
                "While this Mac was away, m1-linux raised an alert: CPU load average above 4",
            )),
            START + 1,
            &[]
        )
    );
    fixture.receive(&[], false);
    assert_eq!(fixture.take(), Seen::default());
}

#[test]
fn changing_the_mirror_epoch_flushes_pending_alerts_and_resets_the_floor() {
    let mut fixture = Mirrored::new(true, 0);
    let reset_at = START + FRESH_MS + 10;
    fixture.now.store(reset_at, Ordering::Relaxed);
    let pending = [alert(START)];
    fixture.receive(&pending, true);
    assert_eq!(fixture.take(), fixture.expected(None, 0, &pending));
    fixture.wire(true, 0);
    assert_eq!(fixture.take(), Seen::default(), "same epoch");

    fixture.history.reset(reset_at).unwrap();
    fixture.history.register_host(&fixture.host).unwrap();
    // The replay came from before the new floor. Only the held group is announced.
    fixture.cursor = None;
    fixture.receive(&[], true);
    assert_eq!(
        fixture.take(),
        fixture.expected(
            Some(group_text(
                "While this Mac was away, m1-linux raised an alert: CPU load average above 4",
            )),
            START,
            &pending
        )
    );
    let fresh = [alert(reset_at)];
    fixture.receive(&fresh, false);
    assert_eq!(
        fixture.take(),
        fixture.expected(Some(single_text()), reset_at, &fresh)
    );
    fixture.receive(&[], false);
    assert_eq!(fixture.take(), Seen::default());
}

#[test]
fn forgetting_a_host_clears_pending_alerts_and_ignores_later_batches() {
    let mut fixture = Mirrored::new(true, 0);
    fixture.now.store(START + FRESH_MS + 10, Ordering::Relaxed);
    let pending = [alert(START)];
    fixture.receive(&pending, true);
    assert_eq!(fixture.take(), fixture.expected(None, 0, &pending));

    fixture.forget();
    fixture.receive(&[alert(START + 1)], false);
    assert_eq!(fixture.take(), Seen::default());
    fixture.wire(true, 0);
    fixture.receive(&[], false);
    assert_eq!(fixture.take(), Seen::default());
}

#[test]
fn a_removed_registration_cannot_recreate_its_alert_floor() {
    let mut fixture = Mirrored::new(true, 0);
    // An epoch mismatch would send the old callback through register again.
    fixture.history.reset(START).unwrap();
    fixture.history.register_host(&fixture.host).unwrap();
    fixture
        .app
        .state::<Mutex<BTreeMap<HostId, Uuid>>>()
        .lock_ok()
        .remove(&HOST);
    fixture.forget();

    let events = [alert(START)];
    fixture.receive(&events, false);
    assert_eq!(fixture.take(), Seen::default());
    assert!(
        read_floors(&fixture.dir.path().join(FLOORS_FILE))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .history
            .read(|reader| reader.events(HOST, START, START + 1))
            .unwrap(),
        events
    );
}

#[test]
fn first_firing_after_registration_delivers_and_replayed_page_is_quiet() {
    let mut fixture = Mirrored::new(true, 0);
    let floors = read_floors(&fixture.dir.path().join(FLOORS_FILE)).unwrap();
    assert_eq!(floors.get(&HOST).unwrap().floor_ms, START);
    let events = [alert(START - 1), alert(START)];
    let page = fixture.page(&events, false);
    fixture.ingest(page.clone());
    assert_eq!(
        fixture.take(),
        fixture.expected(Some(single_text()), START, &events)
    );
    fixture.ingest(page);
    assert_eq!(fixture.take(), Seen::default());
}

#[test]
fn a_remote_mac_inserts_history_without_alert_delivery() {
    let mut fixture = Mirrored::new(false, 0);
    let event = alert(START);
    fixture.receive(std::slice::from_ref(&event), false);
    assert_eq!(fixture.take(), Seen::default());
    assert_eq!(
        fixture
            .history
            .read(|reader| reader.events(HOST, START, START + 1))
            .unwrap(),
        [event]
    );
}

#[test]
fn a_new_source_epoch_keeps_the_floor_for_the_same_mirror() {
    let mut fixture = Mirrored::new(true, 0);
    fixture.receive(&[alert(START - 1)], false);
    fixture.take();
    fixture.source = Mirrored::open_source(fixture.dir.path(), &fixture.host, "reset.sqlite");
    fixture.cursor = None;
    let fresh = [alert(START + 1)];
    fixture.now.store(START + 1, Ordering::Relaxed);
    fixture.receive(&fresh, false);
    assert_eq!(
        fixture.take(),
        fixture.expected(Some(single_text()), START + 1, &fresh)
    );
}

#[test]
fn readding_a_removed_host_keeps_alerts_from_its_absence_in_the_timeline() {
    let mut fixture = Mirrored::new(true, 0);
    fixture.receive(&[alert(START - 1)], false);
    fixture.take();
    fixture.forget();
    fixture.now.store(START + FRESH_MS + 10, Ordering::Relaxed);
    fixture.wire(true, 0);
    let absent = [alert(START + 1)];
    fixture.receive(&absent, false);
    assert_eq!(fixture.take(), fixture.expected(None, 0, &absent));
}

#[test]
fn a_sync_pass_holds_late_alerts_until_its_final_page_and_fresh_alerts_go_at_once() {
    let offset = 7_200_000;
    let mut fixture = Mirrored::new(true, offset);
    fixture.receive(&[alert(START - 1 + offset)], false);
    fixture.take();
    let now = START + FRESH_MS + 10;
    fixture.now.store(now, Ordering::Relaxed);
    let first = [alert(START + offset), alert(now - FRESH_MS + offset)];
    fixture.receive(&first, true);
    assert_eq!(
        fixture.take(),
        fixture.expected(Some(single_text()), now - FRESH_MS, &first)
    );
    let mut disk = alert(now - FRESH_MS - 1 + offset);
    let EventDetail::Alert {
        rule_id, rule_name, ..
    } = &mut disk.detail
    else {
        unreachable!()
    };
    *rule_id = Uuid::from_u128(12);
    *rule_name = "Disk is tight".into();
    let second = [alert(START + 2 + offset), disk];
    fixture.receive(&second, true);
    assert_eq!(fixture.take(), fixture.expected(None, 0, &second));
    fixture.wire(true, -offset);
    fixture.receive(&[], false);
    assert_eq!(fixture.take(), fixture.expected(Some(group_text(
        "While this Mac was away, m1-linux raised 3 alerts: CPU load average above 4 (twice) and Disk is tight",
    )), now - FRESH_MS - 1, &[]));
    fixture.wire(true, offset);
    let later = [alert(START + 3 + offset)];
    fixture.receive(&later, false);
    assert_eq!(
        fixture.take(),
        fixture.expected(
            Some(group_text(
                "While this Mac was away, m1-linux raised an alert: CPU load average above 4",
            )),
            START + 3,
            &later
        )
    );
    fixture.receive(&[], false);
    assert_eq!(fixture.take(), Seen::default());
}

#[test]
fn destination_time_uses_the_same_clock_correction_as_routing() {
    for offset in [-7_200_000, 7_200_000] {
        let mut fixture = Mirrored::new(true, offset);
        fixture.receive(&[alert(START - 1 + offset)], false);
        fixture.take();
        let fresh = [alert(START + offset)];
        fixture.receive(&fresh, false);
        assert_eq!(
            fixture.take(),
            fixture.expected(Some(single_text()), START, &fresh)
        );
    }
}

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
    now: i64,
    offset: Option<i64>,
    timestamps: &[i64],
) -> Vec<Step> {
    receive_in_mirror(delivery, host, MIRROR_EPOCH, now, offset, timestamps)
}

fn receive_in_mirror(
    delivery: &RemoteDelivery,
    host: HostId,
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
            mirror_epoch,
            events: &events,
            caught_up: true,
        },
        now,
        offset.unwrap_or_default(),
        &sinks,
        |late| {
            sinks.0.borrow_mut().push(Step::CatchUp(
                late.iter().map(|alert| alert.event.ts_ms).collect(),
            ));
        },
    );
    sinks.0.into_inner()
}

fn receive(delivery: &RemoteDelivery, now: i64, timestamps: &[i64]) -> Vec<Step> {
    receive_for(delivery, HOST, now, None, timestamps)
}

fn register(delivery: &RemoteDelivery, host: HostId, epoch: Uuid, floor: i64) {
    delivery.register(host, epoch, floor, |_| panic!("unexpected catch-up"));
}

#[test]
fn reregistering_preserves_the_floor_and_each_host_has_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let delivery = RemoteDelivery::open(dir.path());
    let other_host = HostId(Uuid::from_u128(3));
    let historical = START - 1;
    let future = START + 1;
    register(&delivery, HOST, MIRROR_EPOCH, START);
    register(&delivery, other_host, MIRROR_EPOCH, future + 1);
    assert_eq!(
        receive(&delivery, START, &[historical, future]),
        [
            Step::Publish(historical),
            Step::Notify(future),
            Step::Deliver(future),
            Step::Publish(future)
        ]
    );
    assert_eq!(
        receive_for(&delivery, other_host, future, None, &[future]),
        [Step::Publish(future)]
    );
    register(&delivery, HOST, MIRROR_EPOCH, future);
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
    register(&delivery, HOST, MIRROR_EPOCH, START);
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
    register(&delivery, HOST, MIRROR_EPOCH, START);
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
        register(&delivery, HOST, MIRROR_EPOCH, START);
        assert_eq!(
            receive_for(&delivery, HOST, now, Some(offset), &[back, stale, fresh],),
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
    register(&delivery, HOST, MIRROR_EPOCH, START);
    let other = HostId(Uuid::from_u128(5));
    register(&delivery, other, MIRROR_EPOCH, START + 1);
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
        receive_for(&delivery, other, now, None, &[START, START + 1]),
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
        register(delivery, HOST, mirror_epoch, now);
        receive_in_mirror(delivery, HOST, mirror_epoch, now, None, &[timestamp])
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
        register(&delivery, HOST, MIRROR_EPOCH, START);
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
            register(&delivery, HOST, MIRROR_EPOCH, START);
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
        body: "While this Mac was away, m1-linux raised 2 alerts: CPU load average above 4 (twice)"
            .into(),
        rule: None,
        kind: "catch_up",
    };
    let message = Message::from_alert_text(expected.clone(), "m1-linux", START + 1);
    let notifications = RefCell::new(Vec::new());
    let sent = RefCell::new(Vec::new());
    register(&alerts.remote_delivery, HOST, MIRROR_EPOCH, START);
    alerts.remote_delivery.receive(
        Batch {
            host: HOST,
            mirror_epoch: MIRROR_EPOCH,
            events: &events,
            caught_up: true,
        },
        START + 2 + FRESH_MS,
        0,
        &Recorded::default(),
        |late| {
            announce_catch_up(
                &alerts,
                "m1-linux",
                &units,
                late.iter().map(|alert| &alert.event),
                late.iter().map(|alert| alert.local_ms).max().unwrap(),
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
