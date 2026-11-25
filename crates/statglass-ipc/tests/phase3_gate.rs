//! Phase 3 gate: a phone mirror syncs only minutes and quarter hours, and a week of
//! history read through the phone's Auto choice comes from the 15-minute tier. Real
//! SQLite in a temp directory; no session or webview.
use statglass_engine::HistoryStore;
use statglass_schema::{HostId, HostInfo, HostRecord, OsKind, Tier};
use statglass_session::{Mirror, MirrorPolicy, MirrorSink, PHONE_MIRROR_HOST_MB};
use statglass_store::HistoryQuery;
use std::sync::Arc;

const NOW: i64 = 1_788_220_800_000;
const DAY: i64 = 86_400_000;

fn remote_host(id: HostId) -> HostRecord {
    HostRecord {
        id,
        is_local: false,
        display_name: "studio".into(),
        info: HostInfo {
            os: OsKind::MacOs,
            os_version: "27.0".into(),
            model: None,
            chip: None,
            chip_known: true,
            cpu_topology: Vec::new(),
            mem_total_bytes: 0,
            boot_time_ms: 0,
            gpu_dvfs_mhz: Vec::new(),
            kernel: None,
            boot_mounts: Vec::new(),
        },
    }
}

#[test]
fn a_phone_mirror_syncs_minutes_and_quarter_hours_and_reads_a_week_from_m15() {
    let dir = tempfile::tempdir().unwrap();
    let history = Arc::new(HistoryStore::open(dir.path()));
    let record =
        remote_host(serde_json::from_str(r#""7f3a2c00-0000-4000-8000-000000000001""#).unwrap());
    assert!(history.register_host(&record).is_some());
    let host: HostId = record.id;
    let policy = MirrorPolicy::phone(PHONE_MIRROR_HOST_MB);
    let mirror = Mirror::with_policy(history.clone(), host, policy.clone());

    assert_eq!(mirror.sync_tiers(), &[Tier::M1, Tier::M15]);

    let week = HistoryQuery {
        host,
        selectors: Vec::new(),
        from_ms: NOW - 7 * DAY,
        to_ms: NOW,
        tier: policy.auto_choice(),
        max_points: 1_000,
    };
    let page = history.read(|r| r.history(&week)).unwrap();
    assert_eq!(page.tier, Tier::M15);
}
