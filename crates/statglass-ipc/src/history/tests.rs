use super::*;
use statglass_schema::{HostInfo, HostRecord, Labels, MetricId, OsKind};

fn record() -> HostRecord {
    HostRecord {
        id: HostId(Default::default()),
        is_local: true,
        display_name: "Mac".into(),
        info: HostInfo {
            os: OsKind::MacOs,
            os_version: "27.0".into(),
            model: None,
            chip: None,
            chip_known: true,
            cpu_topology: vec![],
            mem_total_bytes: 0,
            boot_time_ms: 0,
            gpu_dvfs_mhz: vec![],
            boot_mounts: vec![],
            kernel: None,
        },
    }
}

const START: i64 = 1_800_000_000_000;

#[test]
fn seeded_history_pages_keep_tiers_recent_rows_and_holds() {
    let dir = tempfile::tempdir().unwrap();
    let history = HistoryStore::open(dir.path());
    let record = record();
    let writer = history.register_host(&record).unwrap();
    let key = SeriesKey::parse("cpu.total").unwrap();
    let row = |tier, bucket_ts, value| BucketRow {
        host: record.id,
        tier,
        bucket_ts,
        series: vec![key.clone()].into(),
        stats: vec![value - 1.0, value + 1.0, value],
    };
    writer.write_bucket(row(Tier::S10, START, 20.0)).unwrap();
    writer.write_bucket(row(Tier::M1, START, 40.0)).unwrap();
    writer.flush().unwrap();
    let recent = || vec![row(Tier::S10, START + 10_000, 30.0)];
    let hold = |_: &SeriesKey, bucket_ms| bucket_ms * 2;
    let point = |t, avg| HistoryPoint {
        t,
        min: avg - 1.0,
        max: avg + 1.0,
        avg,
    };
    for (tier, expected_tier, bucket_ms, points) in [
        (
            TierRequest::Auto,
            Tier::S10,
            10_000,
            vec![point(START, 20.0), point(START + 10_000, 30.0)],
        ),
        (
            TierRequest::S10,
            Tier::S10,
            10_000,
            vec![point(START, 20.0), point(START + 10_000, 30.0)],
        ),
        (TierRequest::M1, Tier::M1, 60_000, vec![point(START, 40.0)]),
    ] {
        let request = HistoryRequest {
            host: record.id,
            selectors: vec![statglass_schema::SeriesSelector {
                metric: MetricId::from_static("cpu.total"),
                labels: Labels::new(),
            }],
            from_ms: START,
            to_ms: START + 60_000,
            tier,
            max_points: 100,
        };
        assert_eq!(
            query_history(&history, &request, TierChoice::Auto, recent, hold).unwrap(),
            HistoryPage {
                tier: expected_tier,
                bucket_ms,
                series: vec![HistorySeries {
                    key: key.clone(),
                    hold_ms: bucket_ms * 2,
                    points
                }],
                gaps: vec![],
            },
        );
    }
}

#[test]
fn history_honors_tier_policy_and_validates_before_reading() {
    let coverage = TierChoice::Covered(statglass_store::TierCoverage {
        s10_ms: None,
        m1_ms: Some(86_400_000),
    });
    let mut request = HistoryRequest {
        host: record().id,
        selectors: vec![],
        from_ms: START,
        to_ms: START + 60_000,
        tier: TierRequest::Auto,
        max_points: 10,
    };
    assert_eq!(request.to_query().unwrap().tier, TierChoice::Auto);
    assert_eq!(request.to_query_with(coverage).unwrap().tier, coverage);
    request.tier = TierRequest::M15;
    assert_eq!(
        request.to_query_with(coverage).unwrap().tier,
        TierChoice::Fixed(Tier::M15)
    );
    let history = HistoryStore::unavailable();
    let read = |request: &HistoryRequest| {
        query_history(&history, request, TierChoice::Auto, Vec::new, |_, ms| ms)
    };
    assert_eq!(
        read(&request).unwrap(),
        HistoryPage {
            tier: Tier::M15,
            bucket_ms: 900_000,
            series: vec![],
            gaps: vec![],
        },
    );
    request.max_points = 0;
    assert_eq!(
        read(&request),
        Err(CommandError::InvalidArgument {
            message: "max_points must be at least 1".into(),
        }),
    );
    request.max_points = 10;
    request.to_ms = START;
    assert!(matches!(
        read(&request),
        Err(CommandError::InvalidArgument { .. })
    ));
}

#[test]
fn events_are_ordered_and_distinguish_empty_missing_and_unavailable_history() {
    let dir = tempfile::tempdir().unwrap();
    let history = HistoryStore::open(dir.path());
    let mut host = record();
    let missing = host.id;
    host.id = HostId("7f3a2c00-0000-4000-8000-000000000001".parse().unwrap());
    let writer = history.register_host(&host).unwrap();
    let event = |delta| Event {
        ts_ms: START + delta,
        start_ms: START + delta - 500,
        processes: vec![],
        detail: statglass_schema::EventDetail::FansRamped {
            from_rpm: 1000.0,
            to_rpm: 2000.0,
        },
    };
    for delta in [3000, 2000, 1000, 0, -1000] {
        writer.record_event(host.id, &event(delta)).unwrap();
    }
    writer.flush().unwrap();
    assert_eq!(
        query_events(&history, host.id, START, START + 3000).unwrap(),
        vec![event(0), event(1000), event(2000)],
    );
    assert!(
        query_events(&history, host.id, START + 3001, START + 4000)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        query_events(&history, missing, START, START + 3000),
        Err(CommandError::UnknownHost { host: missing }),
    );
    assert!(matches!(
        query_events(&HistoryStore::unavailable(), host.id, START, START + 3000),
        Err(CommandError::HistoryUnavailable { .. })
    ));
}
