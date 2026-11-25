use std::path::Path;
use std::sync::{Arc, Mutex};

use statglass_engine::{HISTORY_DB_FILE, HistoryStore};
use statglass_proto::{Message, SyncPage};
use statglass_remote::{Mirror, MirrorError, MirrorSink, page_to_wire};
use statglass_schema::{
    AlertCause, Cmp, Event, EventDetail, HostId, HostInfo, HostRecord, Labels, MetricId, OsKind,
    SyncKinds, Tier, lock::LockExt,
};
use statglass_store::{Reader, Store, StoreConfig};
use uuid::Uuid;

const TS: i64 = 1_788_220_800_000;

#[test]
fn mirror_delivers_alerts_once_and_only_after_commit() {
    let dir = tempfile::tempdir().unwrap();
    let (mirror, host, page, alerts) = fixture(dir.path());
    let epoch = page.epoch;
    let db = dir.path().join(HISTORY_DB_FILE);
    let deliveries = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::clone(&deliveries);
    mirror.set_alert_listener(Arc::new(move |epoch, inserted| {
        let mut reader = Reader::open(&db).expect("open mirror reader inside the listener");
        let committed = reader
            .events(host, TS, TS + 60_000)
            .expect("read committed alerts");
        received.lock_ok().push((epoch, inserted, committed));
    }));

    mirror
        .cursor(Tier::M1, Uuid::new_v4(), SyncKinds::ALL)
        .unwrap();
    let error = mirror.ingest(page.clone(), SyncKinds::ALL).unwrap_err();
    assert!(matches!(
        error,
        MirrorError::EpochChanged {
            operation: "history"
        }
    ));
    assert_eq!(error.to_string(), "Obsolete history epoch");
    assert!(deliveries.lock_ok().is_empty());

    mirror.cursor(Tier::M1, epoch, SyncKinds::ALL).unwrap();
    let mut empty = page.clone();
    empty.events.clear();
    empty.last_seq = 0;
    mirror.ingest(empty, SyncKinds::ALL).unwrap();
    assert!(deliveries.lock_ok().is_empty());

    mirror.ingest(page.clone(), SyncKinds::ALL).unwrap();
    let [later, earlier] = alerts;
    let expected = [(
        epoch,
        vec![later.clone(), earlier.clone()],
        vec![earlier, later],
    )];
    assert_eq!(deliveries.lock_ok().as_slice(), &expected);
    mirror.ingest(page, SyncKinds::ALL).unwrap();
    assert_eq!(deliveries.lock_ok().as_slice(), &expected);
}

#[test]
fn mirror_delivers_alerts_with_reused_source_ids_in_a_new_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let (mirror, _, page, alerts) = fixture(dir.path());
    let deliveries = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::clone(&deliveries);
    mirror.set_alert_listener(Arc::new(move |epoch, inserted| {
        received.lock_ok().push((epoch, inserted));
    }));

    let first = page.epoch;
    mirror.cursor(Tier::M1, first, SyncKinds::ALL).unwrap();
    mirror.ingest(page.clone(), SyncKinds::ALL).unwrap();

    let next = Uuid::new_v4();
    mirror.cursor(Tier::M1, next, SyncKinds::ALL).unwrap();
    mirror
        .ingest(
            SyncPage {
                epoch: next,
                ..page
            },
            SyncKinds::ALL,
        )
        .unwrap();
    assert_eq!(
        deliveries.lock_ok().as_slice(),
        &[(first, alerts.to_vec()), (next, alerts.to_vec())]
    );
}

#[test]
fn mirror_commits_alerts_without_a_listener() {
    let dir = tempfile::tempdir().unwrap();
    let (mirror, host, page, [later, earlier]) = fixture(dir.path());
    mirror.cursor(Tier::M1, page.epoch, SyncKinds::ALL).unwrap();
    mirror.ingest(page, SyncKinds::ALL).unwrap();

    let mut reader = Reader::open(&dir.path().join(HISTORY_DB_FILE)).unwrap();
    assert_eq!(
        reader.events(host, TS, TS + 60_000).unwrap(),
        [earlier, later]
    );
}

fn fixture(dir: &Path) -> (Mirror, HostId, SyncPage, [Event; 2]) {
    let host = HostRecord {
        id: HostId(Uuid::new_v4()),
        is_local: false,
        display_name: "Linux agent".into(),
        info: HostInfo {
            os: OsKind::Linux,
            os_version: "6.17".into(),
            model: None,
            chip: None,
            chip_known: false,
            cpu_topology: vec![],
            mem_total_bytes: 8 << 30,
            boot_time_ms: 0,
            gpu_dvfs_mhz: vec![],
            boot_mounts: vec![],
            kernel: None,
        },
    };
    let source =
        Store::open(StoreConfig::new(dir.join("source.sqlite"))).expect("open source store");
    let writer = source.writer();
    writer
        .upsert_host(host.clone())
        .expect("register source host");
    let alerts = [alert(TS + 1000, 93.0), alert(TS, 95.0)];
    for event in &alerts {
        writer
            .record_event(host.id, event)
            .expect("record source alert");
    }
    writer.flush().expect("commit source alerts");
    let read = source
        .reader()
        .expect("open source reader")
        .read_after(host.id, Tier::M1, None, 10, SyncKinds::ALL)
        .expect("export source alerts");
    let Message::SyncPage(page) = page_to_wire(read) else {
        panic!("expected a sync page with source alerts");
    };
    let history = Arc::new(HistoryStore::open(dir));
    history
        .register_host(&host)
        .expect("register mirrored host");
    (Mirror::new(history, host.id, 100), host.id, page, alerts)
}

fn alert(ts_ms: i64, value: f32) -> Event {
    Event {
        ts_ms,
        start_ms: ts_ms - 60_000,
        processes: vec![],
        detail: EventDetail::Alert {
            rule_id: Uuid::from_u128(1),
            rule_name: "High CPU".into(),
            cause: AlertCause::Threshold {
                metric: MetricId::from_static("cpu.total"),
                labels: Labels::default(),
                value,
                op: Cmp::Gt,
                threshold: 80.0,
                for_secs: 60,
            },
        },
    }
}
