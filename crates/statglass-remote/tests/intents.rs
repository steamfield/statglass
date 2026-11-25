use serde_json::json;
use statglass_remote::{
    DeviceTag, EcdsaP256Public,
    intents::{IntentLog, IntentOp, IntentRecord},
};
use statglass_schema::HostId;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::PermissionsExt,
    sync::{
        Arc, Barrier,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};
use uuid::Uuid;

struct CountWarnings(Arc<AtomicUsize>);

impl tracing::Subscriber for CountWarnings {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::Id {
        tracing::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::Id, _: &tracing::Id) {}
    fn enter(&self, _: &tracing::Id) {}
    fn exit(&self, _: &tracing::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        if *event.metadata().level() == tracing::Level::WARN {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
}

const KEY: &str =
    "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=";

fn key_tag() -> DeviceTag {
    let point = EcdsaP256Public([
        4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125,
        129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26,
        127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182,
        64, 104, 55, 191, 81, 245,
    ]);
    DeviceTag::from_key(&point)
}

fn install() -> IntentOp {
    IntentOp::Install {
        key: KEY.into(),
        name: "My iPhone".into(),
    }
}

#[test]
fn sequences_survive_reopen_and_new_intents_supersede_previous_ones() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data/intents.jsonl");
    let host = HostId(Uuid::new_v4());
    let other = HostId(Uuid::new_v4());
    let tag = key_tag();
    let log = IntentLog::open(path.clone()).unwrap();
    let first = log.record(host, tag, install(), 10).unwrap();
    let separate = log.record(other, tag, install(), 20).unwrap();
    let revoke = log.record(host, tag, IntentOp::Revoke, 30).unwrap();
    assert!(first < separate && separate < revoke);
    drop(log);

    let log = IntentLog::open(path.clone()).unwrap();
    let size = fs::metadata(&path).unwrap().len();
    log.mark_applied(first, 40).unwrap();
    log.mark_failed(first, "stale result", 41).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), size);
    let pending = log.pending().unwrap();
    assert_eq!(
        pending.iter().map(|i| i.seq).collect::<Vec<_>>(),
        [separate, revoke]
    );
    assert!(pending[1].install.is_none());

    let re_pair = log.record(host, tag, install(), 50).unwrap();
    assert!(re_pair > revoke);
    let pending = log.pending().unwrap();
    assert_eq!(pending[1].seq, re_pair);
    let (key, name) = pending[1].install.as_ref().unwrap();
    assert_eq!(DeviceTag::from_key(key), tag);
    assert_eq!(name, "My iPhone");

    let revoke = log.record(host, tag, IntentOp::Revoke, 60).unwrap();
    log.mark_applied(revoke, 70).unwrap();
    log.mark_failed(revoke, "already finished", 80).unwrap();
    assert_eq!(
        log.pending()
            .unwrap()
            .iter()
            .map(|i| i.seq)
            .collect::<Vec<_>>(),
        [separate]
    );
    let metadata = fs::metadata(&path).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    let records: Vec<IntentRecord> = fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 6);
    assert_eq!(records[0].at_ms, 10);
    assert_eq!(records[5].op, IntentOp::Applied { seq: revoke });
}

#[test]
fn failures_keep_the_latest_reason_and_attempt_count_across_compaction() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("intents.jsonl");
    let host = HostId(Uuid::new_v4());
    let log = IntentLog::open(path.clone()).unwrap();
    let install = log.record(host, key_tag(), install(), 1).unwrap();
    let revoke = log.record(host, key_tag(), IntentOp::Revoke, 2).unwrap();
    for attempt in 1..=3 {
        log.mark_failed(revoke, &"x".repeat(91_000), attempt)
            .unwrap();
    }
    let snapshot = fs::read_to_string(&path).unwrap();
    let rows: Vec<IntentRecord> = snapshot
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    assert!(snapshot.len() < 256 * 1024);
    assert!(rows.iter().all(|row| row.seq != install));
    let last_seq = rows.last().unwrap().seq;
    drop(log);

    let log = IntentLog::open(path.clone()).unwrap();
    log.mark_failed(revoke, "SSH timed out", 9).unwrap();
    let pending = log.pending().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].seq, revoke);
    assert_eq!(pending[0].attempts, 4);
    assert_eq!(pending[0].last_error.as_deref(), Some("SSH timed out"));
    assert!(pending[0].install.is_none());
    log.mark_applied(revoke, 10).unwrap();
    assert!(log.pending().unwrap().is_empty());
    let body = fs::read_to_string(path).unwrap();
    let finished: IntentRecord = serde_json::from_str(body.lines().last().unwrap()).unwrap();
    assert!(finished.seq > last_seq);
}

#[test]
fn ignores_future_fields_and_ops_and_recovers_from_an_interrupted_append() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("intents.jsonl");
    let host = HostId(Uuid::new_v4());
    let tag = key_tag();
    let row = |seq, op| json!({"seq": seq, "host": host, "device": tag, "op": op, "at_ms": 10, "future": true});
    fs::write(
        &path,
        format!(
            "{}\n{}\n{{\"seq\":40,\"op\":\"revo",
            row(1, "revoke"),
            row(39, "future_op")
        ),
    )
    .unwrap();

    let warnings = Arc::new(AtomicUsize::new(0));
    tracing::subscriber::with_default(CountWarnings(warnings.clone()), || {
        let log = IntentLog::open(path.clone()).unwrap();
        assert_eq!(log.pending().unwrap()[0].seq, 1);
        assert_eq!(log.pending().unwrap()[0].seq, 1);
        assert!(fs::read_to_string(&path).unwrap().ends_with('\n'));
        let next = log.record(host, tag, IntentOp::Revoke, 60).unwrap();
        assert_eq!(next, 40);
        assert_eq!(log.pending().unwrap()[0].seq, next);
    });
    assert_eq!(
        warnings.load(Ordering::Relaxed),
        2,
        "one warning each for the unknown op and truncated line"
    );
    let lines = fs::read_to_string(path).unwrap();
    assert_eq!(lines.lines().count(), 3);
    assert!(
        lines
            .lines()
            .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok())
    );
}

#[test]
fn simultaneous_writers_allocate_distinct_sequences() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("intents.jsonl");
    let barrier = Barrier::new(8);
    thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                let log = IntentLog::open(path.clone()).unwrap();
                barrier.wait();
                log.record(HostId(Uuid::new_v4()), key_tag(), IntentOp::Revoke, 10)
                    .unwrap();
            });
        }
    });
    let body = fs::read_to_string(path).unwrap();
    let seqs: Vec<u64> = body
        .lines()
        .map(|line| serde_json::from_str::<IntentRecord>(line).unwrap().seq)
        .collect();
    assert_eq!(seqs, (1..=8).collect::<Vec<_>>());
}

#[test]
fn rejects_a_corrupt_complete_revoke_and_preserves_the_journal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("intents.jsonl");
    let host = HostId(Uuid::new_v4());
    let log = IntentLog::open(path.clone()).unwrap();
    log.record(host, key_tag(), install(), 1).unwrap();
    writeln!(
        OpenOptions::new().append(true).open(&path).unwrap(),
        "{{\"seq\":2,\"op\":\"revoke\"}}"
    )
    .unwrap();
    let original = fs::read(&path).unwrap();
    assert!(log.pending().is_err());
    assert!(log.record(host, key_tag(), install(), 2).is_err());
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn installed_hosts_include_applied_and_pending_installs_and_exclude_superseded_ones() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("intents.jsonl");
    let log = IntentLog::open(path.clone()).unwrap();
    let tag = key_tag();
    let already_installed = HostId(Uuid::from_u128(1));
    let pending_install = HostId(Uuid::from_u128(2));
    let pending_revoke = HostId(Uuid::from_u128(3));
    let applied_revoke = HostId(Uuid::from_u128(4));
    let install_seq = log.record(already_installed, tag, install(), 1).unwrap();
    log.mark_applied(install_seq, 2).unwrap();
    log.record(pending_install, tag, install(), 3).unwrap();
    log.record(pending_revoke, tag, install(), 4).unwrap();
    log.record(pending_revoke, tag, IntentOp::Revoke, 5)
        .unwrap();
    log.record(applied_revoke, tag, install(), 6).unwrap();
    let revoke_seq = log
        .record(applied_revoke, tag, IntentOp::Revoke, 7)
        .unwrap();
    log.mark_applied(revoke_seq, 8).unwrap();
    drop(log);
    let log = IntentLog::open(path).unwrap();
    assert_eq!(
        log.installed_hosts(&tag).unwrap(),
        [already_installed, pending_install]
    );
    assert!(
        log.installed_hosts(&DeviceTag::parse("AABBCC").unwrap())
            .unwrap()
            .is_empty()
    );
}
