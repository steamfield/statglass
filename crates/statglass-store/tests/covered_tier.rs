//! History, CSV and live-only reads under a mirror's coverage policy.
mod common;

use common::{DAY, HOUR, MIN, T0, bucket, host, layout, open, temp_dir};
use statglass_schema::{HostId, Labels, MetricId, SeriesSelector, Tier};
use statglass_store::{
    ExportQuery, HistoryQuery, Retention, StoreError, TierChoice, TierCoverage, history_recent,
};

const PHONE: TierChoice = TierChoice::Covered(TierCoverage {
    s10_ms: None,
    m1_ms: Some(DAY),
});
const COARSE: TierChoice = TierChoice::Covered(TierCoverage {
    s10_ms: None,
    m1_ms: None,
});
const ALL: TierChoice = TierChoice::Covered(TierCoverage {
    s10_ms: Some(HOUR),
    m1_ms: Some(DAY),
});

fn query(host: HostId, span: i64, tier: TierChoice) -> HistoryQuery {
    HistoryQuery {
        host,
        selectors: vec![SeriesSelector {
            metric: MetricId::from_static("cpu.total"),
            labels: Labels::new(),
        }],
        from_ms: T0 - span,
        to_ms: T0,
        tier,
        max_points: 10_000,
    }
}

fn csv_query(q: &HistoryQuery) -> ExportQuery {
    ExportQuery {
        host: q.host,
        selectors: q.selectors.clone(),
        from_ms: q.from_ms,
        to_ms: q.to_ms,
        tier: q.tier,
    }
}

const RANGES: [(TierChoice, i64, Tier); 9] = [
    (PHONE, HOUR, Tier::M1),
    (PHONE, DAY, Tier::M1),
    (PHONE, DAY + 1, Tier::M15),
    (PHONE, 7 * DAY, Tier::M15),
    (COARSE, HOUR, Tier::M15),
    (COARSE, 7 * DAY, Tier::M15),
    (ALL, HOUR, Tier::S10),
    (ALL, HOUR + 1, Tier::M1),
    (ALL, 7 * DAY, Tier::M15),
];

#[test]
fn covered_history_reads_the_finest_tier_that_fits_the_whole_range() {
    let dir = temp_dir("covered-history");
    let store = open(&dir, "h.sqlite");
    let w = store.writer();
    let h = host(1);
    w.upsert_host(h.clone()).unwrap();
    let l = layout(&["cpu.total"]);
    w.write_bucket(bucket(h.id, Tier::S10, T0 - 10_000, &l, 10.))
        .unwrap();
    w.write_bucket(bucket(h.id, Tier::M1, T0 - DAY, &l, 61.))
        .unwrap();
    w.write_bucket(bucket(h.id, Tier::M1, T0 - MIN, &l, 60.))
        .unwrap();
    w.write_bucket(bucket(h.id, Tier::M15, T0 - DAY, &l, 900.))
        .unwrap();
    w.flush().unwrap();
    let mut r = store.reader().unwrap();

    for (choice, span, tier) in RANGES {
        let q = query(h.id, span, choice);
        let actual = r.history(&q).unwrap();
        let expected = r
            .history(&HistoryQuery {
                tier: TierChoice::Fixed(tier),
                ..q
            })
            .unwrap();
        assert!(!expected.series.is_empty());
        assert_eq!(actual, expected, "{choice:?} with span {span}");
    }

    let mut q = query(h.id, HOUR, PHONE);
    q.selectors[0].metric = MetricId::from_static("mem.used");
    let missing = r.history(&q).unwrap();
    assert_eq!(missing.tier, Tier::M1);
    assert!(missing.series.is_empty());
    q.host = host(2).id;
    assert!(matches!(r.history(&q), Err(StoreError::UnknownHost(_))));
}

#[test]
fn covered_csv_uses_the_resolved_tier_and_releases_the_snapshot_on_io_error() {
    let dir = temp_dir("covered-csv");
    let store = open(&dir, "h.sqlite");
    let w = store.writer();
    let h = host(1);
    w.upsert_host(h.clone()).unwrap();
    let l = layout(&["cpu.total"]);
    w.write_bucket(bucket(h.id, Tier::M1, T0 - MIN, &l, 60.))
        .unwrap();
    w.write_bucket(bucket(h.id, Tier::M15, T0 - DAY, &l, 900.))
        .unwrap();
    w.flush().unwrap();
    let mut r = store.reader().unwrap();

    let mut q = csv_query(&query(h.id, 7 * DAY, PHONE));
    let err = r.export_csv(&q, &mut &mut [][..]).unwrap_err();
    assert!(matches!(err, StoreError::Io(_)), "{err:?}");
    assert!(!r.in_transaction());
    let mut actual = Vec::new();
    let summary = r.export_csv(&q, &mut actual).unwrap();
    assert_eq!(summary.tier, Tier::M15);
    assert_eq!(summary.rows, 2);
    q.tier = TierChoice::Fixed(Tier::M15);
    let mut expected = Vec::new();
    assert_eq!(summary, r.export_csv(&q, &mut expected).unwrap());
    assert_eq!(actual, expected);
}

#[test]
fn covered_live_only_reads_the_same_windows_and_handles_an_empty_snapshot() {
    let h = host(1).id;
    let l = layout(&["cpu.total"]);
    let rows = [
        bucket(h, Tier::S10, T0 - 10_000, &l, 10.),
        bucket(h, Tier::M1, T0 - MIN, &l, 60.),
    ];

    for (choice, span, tier) in RANGES {
        let q = query(h, span, choice);
        let empty = history_recent(&q, &[]).unwrap();
        assert_eq!(empty.tier, tier, "{choice:?} with span {span}");
        assert!(empty.series.is_empty());
        let live = history_recent(&q, &rows).unwrap();
        assert_eq!(live.tier, tier);
        assert_eq!(
            live.series[0].points[0].avg,
            if tier == Tier::S10 { 10. } else { 60. }
        );
    }
}

#[test]
fn covered_s10_respects_pruning_and_low_disk_holes() {
    let dir = temp_dir("covered-s10-cutoffs");
    let store = open(&dir, "h.sqlite");
    let w = store.writer();
    let h = host(1);
    w.upsert_host(h.clone()).unwrap();
    let l = layout(&["cpu.total"]);
    w.write_bucket(bucket(h.id, Tier::S10, T0 - HOUR, &l, 10.))
        .unwrap();
    w.write_bucket(bucket(h.id, Tier::M1, T0 - HOUR, &l, 60.))
        .unwrap();
    w.flush().unwrap();
    let mut r = store.reader().unwrap();
    let q = query(h.id, HOUR, ALL);

    assert_eq!(r.history(&q).unwrap().tier, Tier::S10);
    w.prune_mirror(T0 + DAY - HOUR + MIN, Retention::mirror_default())
        .unwrap();
    assert_eq!(r.history(&q).unwrap().tier, Tier::M1);
    let later = query(h.id, HOUR - MIN, ALL);
    assert_eq!(r.history(&later).unwrap().tier, Tier::S10);
    w.set_s10_paused(true, T0 - MIN).unwrap();
    assert_eq!(r.history(&later).unwrap().tier, Tier::M1);
    assert_eq!(
        r.export_csv(&csv_query(&later), &mut Vec::new())
            .unwrap()
            .tier,
        Tier::M1
    );
}

#[test]
fn covered_history_and_csv_use_quarters_before_the_first_synced_minute() {
    let dir = temp_dir("covered-m1-sync-floor");
    let store = open(&dir, "h.sqlite");
    let w = store.writer();
    let h = host(1);
    w.upsert_host(h.clone()).unwrap();
    let l = layout(&["cpu.total"]);
    let old = T0 - 2 * DAY;
    for slot in 0..4 {
        w.write_bucket(bucket(h.id, Tier::M15, old + slot * 15 * MIN, &l, 900.))
            .unwrap();
    }
    w.flush().unwrap();
    let mut r = store.reader().unwrap();
    let q = HistoryQuery {
        from_ms: old,
        to_ms: old + HOUR,
        ..query(h.id, HOUR, PHONE)
    };
    let before_minute_sync = r.history(&q).unwrap();
    w.write_bucket(bucket(h.id, Tier::M1, T0 - DAY, &l, 60.))
        .unwrap();
    w.flush().unwrap();

    let page = r.history(&q).unwrap();
    let mut csv = Vec::new();
    let summary = r.export_csv(&csv_query(&q), &mut csv).unwrap();
    assert_eq!((page.tier, summary.tier), (Tier::M15, Tier::M15));
    assert_eq!(page, before_minute_sync);
    assert_eq!(page.series[0].points.len(), 4);
    assert!(page.series[0].points.iter().all(|p| p.avg == 900.));
    assert_eq!(summary.rows, 4);
    let mut fixed = csv_query(&q);
    fixed.tier = TierChoice::Fixed(Tier::M15);
    let mut expected = Vec::new();
    assert_eq!(summary, r.export_csv(&fixed, &mut expected).unwrap());
    assert_eq!(csv, expected);
}

#[test]
fn covered_history_and_csv_fall_back_when_minutes_were_pruned_from_a_short_range() {
    let dir = temp_dir("covered-m1-cutoff");
    let store = open(&dir, "h.sqlite");
    let w = store.writer();
    let h = host(1);
    w.upsert_host(h.clone()).unwrap();
    let l = layout(&["cpu.total"]);
    let old = T0 - 2 * DAY;
    w.write_bucket(bucket(h.id, Tier::M1, old, &l, 60.))
        .unwrap();
    w.write_bucket(bucket(h.id, Tier::M15, old, &l, 900.))
        .unwrap();
    w.write_bucket(bucket(h.id, Tier::M1, T0 - DAY, &l, 61.))
        .unwrap();
    w.flush().unwrap();
    let mut r = store.reader().unwrap();
    let q = HistoryQuery {
        from_ms: old,
        to_ms: old + HOUR,
        ..query(h.id, HOUR, PHONE)
    };

    assert_eq!(r.history(&q).unwrap().tier, Tier::M1);
    w.prune_mirror(
        T0,
        Retention {
            m1_ms: DAY,
            ..Retention::mirror_default()
        },
    )
    .unwrap();

    let page = r.history(&q).unwrap();
    assert_eq!(page.tier, Tier::M15);
    assert_eq!(page.series[0].points[0].avg, 900.);
    let summary = r.export_csv(&csv_query(&q), &mut Vec::new()).unwrap();
    assert_eq!((summary.tier, summary.rows), (Tier::M15, 1));
    let at_cutoff = r.history(&query(h.id, DAY, PHONE)).unwrap();
    assert_eq!(at_cutoff.tier, Tier::M1);
    assert_eq!(at_cutoff.series[0].points[0].avg, 61.);
}
