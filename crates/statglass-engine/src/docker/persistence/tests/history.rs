use super::*;
use crate::docker::persistence::projection::mask_uncovered;

#[test]
fn points_claim_no_measurement_inside_collection_or_metric_gaps() {
    let full = |time_ms: i64| api::DockerHistoryPoint {
        time_ms,
        duration_ms: 10_000,
        cpu_measured_ms: 10_000,
        memory_measured_ms: 10_000,
        expected_ms: 10_000,
        cpu_covered: true,
        memory_covered: true,
        ..point(&db::DockerBucket {
            entity: "c".into(),
            tier: Tier::S10,
            bucket_ms: time_ms,
            revision: 1,
            metrics: vec![],
            populations: vec![],
        })
    };
    let mut points: Vec<_> = [0, 10_000, 20_000, 30_000, 40_000]
        .into_iter()
        .map(full)
        .collect();
    let gap = |start, end, id: Option<&str>, reason: &str| {
        api::DockerCoverage::new(start, end, id.map(Into::into), reason.into())
    };
    let gaps = [
        // Spans the first bucket; the overlapping half-gap counts once.
        gap(0, Some(10_000), None, "disconnected"),
        gap(5_000, Some(10_000), Some("c"), "partial_cycle"),
        // Touches the second bucket: measured time is capped, not erased.
        gap(17_000, Some(19_000), Some("c"), "partial_cycle"),
        // Another container, saving and event gaps measure nothing about this one.
        gap(20_000, Some(30_000), Some("other"), "partial_cycle"),
        gap(20_000, Some(40_000), None, "write_failed"),
        gap(20_000, Some(40_000), None, "events_disconnected"),
        // Open: runs to the end of the range.
        gap(45_000, None, None, "paused"),
    ];
    mask_uncovered(&mut points, &gaps, Some("c"), 50_000);
    let measured: Vec<_> = points
        .iter()
        .map(|p| (p.cpu_measured_ms, p.memory_measured_ms, p.cpu_covered))
        .collect();
    assert_eq!(
        measured,
        [
            (0, 0, false),
            (8_000, 8_000, false),
            (10_000, 10_000, true),
            (10_000, 10_000, true),
            (5_000, 5_000, false),
        ]
    );
}

/// Records `s` once a second for `secs` seconds from `t`, every container measured.
fn record_seconds(r: &DockerRecorder, s: &mut api::DockerSnapshot, t: i64, secs: i64) {
    for i in 1..=secs {
        at(s, t + i * 1000, 1000);
        r.record(s);
    }
}
fn cpu_measured(page: &api::DockerHistoryPage, from: i64) -> Vec<(i64, u32, bool)> {
    page.points
        .iter()
        .filter(|p| p.time_ms >= from)
        .map(|p| (p.time_ms - from, p.cpu_measured_ms, p.cpu_covered))
        .collect()
}
fn partial(start: i64, end: i64, id: Option<&str>) -> api::DockerCoverage {
    api::DockerCoverage::new(start, Some(end), id.map(Into::into), "partial_cycle".into())
}

#[test]
fn an_engine_wide_partial_cycle_leaves_a_measured_container_measured() {
    let r = DockerRecorder::new(host().id);
    let t = wall_ms().div_euclid(60_000) * 60_000;
    let mut s = fixture(t);
    // What earlier builds published when any one container's stats failed.
    s.coverage = vec![
        partial(t + 10_000, t + 20_000, None),
        partial(t + 30_000, t + 40_000, Some("other")),
    ];
    r.record(&s);
    record_seconds(&r, &mut s, t, 60);
    let full: Vec<_> = (0..6).map(|i| (i * 10_000, 10_000, true)).collect();
    let page = r.history(&query(t, t + 60_000, 60)).unwrap();
    assert_eq!(cpu_measured(&page, t), full);
    let mut aggregate = query(t, t + 60_000, 60);
    aggregate.container_id = None;
    assert_eq!(cpu_measured(&r.history(&aggregate).unwrap(), t), full);
}

#[test]
fn history_counts_no_measured_time_inside_a_containers_own_partial_cycle() {
    let r = DockerRecorder::new(host().id);
    let t = wall_ms().div_euclid(60_000) * 60_000;
    let mut s = fixture(t);
    s.coverage = vec![partial(t + 20_000, t + 30_000, Some("c"))];
    r.record(&s);
    record_seconds(&r, &mut s, t, 60);
    let page = r.history(&query(t, t + 60_000, 60)).unwrap();
    let mut expected: Vec<_> = (0..6).map(|i| (i * 10_000, 10_000, true)).collect();
    expected[2] = (20_000, 0, false);
    assert_eq!(cpu_measured(&page, t), expected);
}

#[test]
fn comparison_ranks_on_the_measured_time_coverage_leaves() {
    let r = DockerRecorder::new(host().id);
    let t = wall_ms().div_euclid(60_000) * 60_000;
    let mut s = fixture(t);
    let mut d = s.containers[0].clone();
    d.id = "d".into();
    d.name = "d".into();
    d.metrics.cpu_pct = Some(50.);
    s.containers.push(d);
    // c peaked while its stats were failing: that spike was never measured.
    s.containers[0].metrics.cpu_pct = Some(300.);
    s.coverage = vec![
        partial(t, t + 60_000, None),
        partial(t - 1000, t + 30_000, Some("c")),
    ];
    r.record(&s);
    record_seconds(&r, &mut s, t, 30);
    s.containers[0].metrics.cpu_pct = Some(100.);
    record_seconds(&r, &mut s, t + 30_000, 30);
    let page = r
        .comparison(&api::DockerComparisonRequest {
            engine_id: "daemon".into(),
            from_ms: t,
            to_ms: t + 60_000,
            metric: api::DockerComparisonMetric::Cpu,
            project: None,
            selected: None,
            max_points: 60,
        })
        .unwrap();
    let ranking: Vec<_> = page
        .ranking
        .iter()
        .map(|row| {
            (
                row.container.id.as_str(),
                row.peak_cpu_pct,
                row.cpu_measured_ms,
            )
        })
        .collect();
    assert_eq!(
        ranking,
        [("c", Some(100.), 30_000), ("d", Some(50.), 60_000)]
    );
    let c = page
        .series
        .iter()
        .find(|row| row.container.id == "c")
        .unwrap();
    assert!(
        c.points
            .iter()
            .filter(|p| p.time_ms < t + 30_000)
            .all(|p| p.cpu_measured_ms == 0 && !p.cpu_covered)
    );
}

#[test]
fn history_points_publish_coverage_without_client_inference() {
    let mut bucket = db::DockerBucket {
        entity: "c".into(),
        tier: Tier::S10,
        bucket_ms: 0,
        revision: 1,
        metrics: vec![db::WeightedMetric {
            key: "cpu_percent".into(),
            min: 10.,
            max: 10.,
            sum: 100_000.,
            weight_ms: 10_000,
            expected_ms: 10_000,
        }],
        populations: vec![],
    };
    for weight in [10_000, 9999, 9800] {
        bucket.metrics[0].weight_ms = weight;
        assert!(point(&bucket).cpu_covered);
        assert!(!point(&bucket).memory_covered);
        assert_eq!(point(&bucket).peak.cpu_pct, Some(10.));
    }
    for weight in [9799, 0] {
        bucket.metrics[0].weight_ms = weight;
        assert!(!point(&bucket).cpu_covered);
    }
    assert_eq!(point(&bucket).peak.cpu_pct, None);
    bucket.metrics.clear();
    assert!(!point(&bucket).cpu_covered);
}

#[test]
fn nonaligned_hour_is_bounded_and_left_overlap_is_retained() {
    let r = DockerRecorder::new(host().id);
    let t = wall_ms().div_euclid(900_000) * 900_000;
    let mut s = fixture(t + 1000);
    for i in 0..=360 {
        at(&mut s, t + i * 10_000 + 1000, 10000);
        r.record(&s);
    }
    let page = r.history(&query(t + 1000, t + HOUR + 1000, 360)).unwrap();
    assert!(page.points.len() <= 360);
    assert!(page.points.first().unwrap().time_ms <= t + 1000);
    assert_eq!(
        page.points.get(1).unwrap().explicit_limit_bytes,
        Some(1024.)
    );
}

#[test]
fn coarse_database_span_is_not_overwritten_by_partial_ring() {
    let (_dir, store, r) = setup();
    let t = wall_ms().div_euclid(900_000) * 900_000;
    let mut s = fixture(t + 1000);
    r.record(&s);
    for i in 1..=6 {
        at(&mut s, t + i * 10000, 10000);
        r.record(&s);
    }
    store.writer().flush().unwrap();
    r.status();
    {
        let mut state = r.state.lock_ok();
        let removed: Vec<_> = state
            .entries
            .keys()
            .filter(|(_, _, time)| *time < t + 50000)
            .cloned()
            .collect();
        for key in removed {
            let e = state.entries.remove(&key).unwrap();
            state.bytes -= e.bytes;
        }
    }
    at(&mut s, t + 61000, 1000);
    s.containers[0].metrics.cpu_pct = Some(300.);
    r.record(&s);
    let page = r.history(&query(t, t + 3_600_000, 60)).unwrap();
    let first = page.points.first().unwrap();
    assert!(first.cpu_measured_ms >= 59000, "{first:?}");
    assert!(first.metrics.cpu_pct.unwrap() < 110.);
}

#[test]
fn same_nanosecond_ring_database_pagination_does_not_skip_or_repeat() {
    let (_dir, store, r) = setup();
    let t = wall_ms();
    let make = |id: &str| api::DockerEvent {
        id: id.into(),
        engine_id: "daemon".into(),
        container_id: Some(id.into()),
        time_ns: (t * 1_000_000 + 1).to_string(),
        time_ms: t,
        action: "oom".into(),
        attributes: BTreeMap::new(),
        name: None,
        exit_code: None,
    };
    for id in ["a", "b", "c"] {
        r.event(&make(id), 1);
    }
    store.writer().flush().unwrap();
    r.status();
    r.event(&make("d"), 1);
    let mut q = api::DockerEventsRequest {
        engine_id: "daemon".into(),
        container_id: None,
        from_ms: t,
        to_ms: t + 1,
        limit: 2,
        before_id: None,
    };
    let first = r.events(&q).unwrap();
    assert_eq!(first.events.len(), 2);
    q.before_id = first.next_id;
    let second = r.events(&q).unwrap();
    assert_eq!(second.events.len(), 2);
    let ids: BTreeSet<_> = first
        .events
        .iter()
        .chain(&second.events)
        .map(|e| &e.id)
        .collect();
    assert_eq!(ids.len(), 4);
}

#[test]
fn reset_invalidates_reader_pins_and_discards_late_generation() {
    let (_dir, store, r) = setup();
    let t = wall_ms();
    r.record(&fixture(t));
    let pin = {
        let mut s = r.state.lock_ok();
        s.reader_bytes += 100;
        ReadPin {
            state: &r.state,
            bytes: 100,
            generation: s.generation,
            reset_epoch: s.reset_epoch,
            started: Instant::now(),
        }
    };
    r.reset(2).unwrap();
    assert!(!pin.valid());
    assert_eq!(r.state.lock_ok().reader_bytes, 100);
    drop(pin);
    assert_eq!(r.state.lock_ok().reader_bytes, 0);
    r.record(&fixture(t + 1000));
    assert!(r.state.lock_ok().entries.is_empty());
    store.writer().flush().unwrap();
}

#[test]
fn review_short_history_falls_back_after_age_or_partial_fine_reclamation() {
    for age in [true, false] {
        let (_dir, store, r) = setup();
        let now = wall_ms().div_euclid(900000) * 900000;
        let t = if age { now - 2 * 86400000 } else { now };
        let mut s = fixture(t + 10000);
        for i in 1..=6 {
            at(&mut s, t + i * 10000, 10000);
            r.record(&s);
        }
        r.shutdown_flush().unwrap();
        if age {
            store
                .writer()
                .prune(now, statglass_store::Retention::default())
                .unwrap();
        } else {
            let conn = rusqlite::Connection::open(store.path()).unwrap();
            conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
            conn.execute("DELETE FROM docker_10s WHERE bucket_ms=?1", [t + 20000])
                .unwrap();
        }
        let fresh = DockerRecorder::new(host().id);
        fresh.attach(store.writer(), store.path().to_path_buf());
        let page = fresh.history(&query(t, t + 3600000, 360)).unwrap();
        assert_eq!(page.points.len(), 1, "age={age}");
        assert_eq!(page.points[0].duration_ms, 60000);
        assert_eq!(page.points[0].cpu_measured_ms, 60000);
        assert_eq!(page.points[0].metrics.cpu_pct, Some(100.));
    }
}
