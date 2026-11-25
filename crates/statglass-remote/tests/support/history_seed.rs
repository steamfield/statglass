use std::{path::Path, sync::Arc};

use statglass_engine::HistoryStore;
use statglass_schema::{HostId, HostInfo, HostRecord, OsKind, SeriesKey, Tier};
use statglass_store::{BucketRow, Retention, Writer};

pub fn seed_by_retention(dir: &Path, series: &[SeriesKey], now_ms: i64) -> Arc<HistoryStore> {
    seed_by_retention_with_layout(dir, series, now_ms, false)
}

pub fn seed_by_retention_with_layout(
    dir: &Path,
    series: &[SeriesKey],
    now_ms: i64,
    wide: bool,
) -> Arc<HistoryStore> {
    let store = Arc::new(HistoryStore::open(dir));
    let host = host_record();
    let writer = store.register_host(&host).expect("register fixture host");
    let retention = Retention::with_days(30);
    if wide {
        write_layout(&writer, host.id, series.into(), now_ms, retention);
    } else {
        let (cores, other): (Vec<_>, Vec<_>) = series
            .iter()
            .cloned()
            .partition(|key| key.metric.as_str() == "cpu.load");
        for layout in other
            .chunks(10)
            .chain([cores.as_slice()])
            .filter(|l| !l.is_empty())
        {
            write_layout(&writer, host.id, layout.into(), now_ms, retention);
        }
    }
    writer
        .prune(now_ms, retention)
        .expect("prune history fixture");
    store
}

pub fn host_record() -> HostRecord {
    HostRecord {
        id: HostId(uuid::Uuid::nil()),
        is_local: true,
        display_name: "History fixture".into(),
        info: HostInfo {
            os: OsKind::Linux,
            os_version: "fixture".into(),
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
    }
}

fn write_layout(
    writer: &Writer,
    host: HostId,
    series: Arc<[SeriesKey]>,
    now: i64,
    keep: Retention,
) {
    let quarter = Tier::M15.bucket_ms().expect("M15 has a bucket width");
    let minute_start = Tier::M15
        .bucket_start(now - keep.m1_ms)
        .expect("M15 has a bucket start");
    for (tier, from, to) in [
        (Tier::S10, now - keep.s10_ms - 10_000, now),
        // The first quarter rolls down and sets the M1 coverage mark.
        (Tier::M1, minute_start - quarter, now),
        (Tier::M15, now - keep.history_ms, minute_start - quarter),
    ] {
        let width = tier
            .bucket_ms()
            .expect("persisted tiers have a bucket width");
        let from = tier
            .bucket_start(from)
            .expect("persisted tiers have a bucket start");
        let step = usize::try_from(width).expect("bucket width fits in usize");
        for bucket_ts in (from..now.min(to)).step_by(step) {
            let drift = (bucket_ts / width).rem_euclid(97) as f32 / 93.0;
            let stats = (0..series.len())
                .flat_map(|i| {
                    let avg = 10.0 + i as f32 + drift;
                    [avg - 0.37, avg + 0.61, avg]
                })
                .collect();
            writer
                .write_bucket(BucketRow {
                    host,
                    tier,
                    bucket_ts,
                    series: series.clone(),
                    stats,
                })
                .expect("queue fixture bucket");
        }
    }
}
