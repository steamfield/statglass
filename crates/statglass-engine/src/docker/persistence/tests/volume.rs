use super::*;

const DAY: i64 = 86_400_000;

/// A store holding one flapping container's 12,000 closed `partial_cycle` rows across 30
/// days, one of which spans the bucket `c` was measured in, plus one engine-wide event
/// record. `d` is measured in the same bucket and has no rows of its own.
fn flapping_store() -> (DatabaseFixture, Store, DockerRecorder, i64) {
    let (dir, store, r) = setup();
    let t = wall_ms().div_euclid(900_000) * 900_000 - 900_000 + 5_000;
    let mut s = fixture(t);
    let mut d = s.containers[0].clone();
    d.id = "d".into();
    s.containers.push(d);
    r.record(&s);
    r.shutdown_flush().unwrap();
    store.writer().flush().unwrap();
    let conn = rusqlite::Connection::open(store.path()).unwrap();
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO docker_coverage(host_id,engine_id,entity_id,metric,start_ms,end_ms,reason,revision,sampled_ms,expected_ms) SELECT host_id,engine_id,id,NULL,?1,?2,?3,1,0,?2-?1 FROM docker_entities WHERE external_id=?4")
            .unwrap();
        let first = t - 29 * DAY;
        for n in 0..12_000 {
            let start = first + n * 200_000;
            insert
                .execute(rusqlite::params![
                    start,
                    start + 10_000,
                    "partial_cycle",
                    "c"
                ])
                .unwrap();
        }
        insert
            .execute(rusqlite::params![
                t - 10_800_000,
                t + 10_800_000,
                "partial_cycle",
                "c"
            ])
            .unwrap();
        tx.execute("INSERT INTO docker_coverage(host_id,engine_id,entity_id,metric,start_ms,end_ms,reason,revision,sampled_ms,expected_ms) SELECT host_id,engine_id,NULL,NULL,?1,?1+1000,'events_dropped_rate_limit',1,0,1000 FROM docker_entities WHERE external_id='c'",[t - DAY]).unwrap();
    }
    tx.commit().unwrap();
    // A fresh recorder: everything comes from SQLite.
    let fresh = DockerRecorder::new(host().id);
    fresh.attach(store.writer(), store.path().to_path_buf());
    drop(r);
    (dir, store, fresh, t)
}

#[test]
fn a_flapping_containers_rows_never_break_comparison_events_or_history() {
    let (_dir, _store, r, t) = flapping_store();
    let q = api::DockerComparisonRequest {
        engine_id: "daemon".into(),
        from_ms: t + 60_000 - db::MAX_RANGE_MS,
        to_ms: t + 60_000,
        metric: api::DockerComparisonMetric::Cpu,
        project: None,
        selected: None,
        max_points: 360,
    };
    let started = Instant::now();
    let page = r.comparison(&q);
    eprintln!(
        "30-day comparison over 12,002 coverage rows: {:?} ({})",
        started.elapsed(),
        if page.is_ok() { "ok" } else { "error" }
    );
    let page = page.unwrap();
    // c's only bucket lies inside its own record, so c measured nothing; d is untouched.
    let ids: Vec<_> = page
        .ranking
        .iter()
        .map(|r| r.container.id.as_str())
        .collect();
    assert_eq!(ids, ["d"]);
    assert_eq!(page.ranking[0].cpu_measured_ms, 1000);

    let history = r
        .history(&api::DockerHistoryRequest {
            engine_id: "daemon".into(),
            container_id: Some("c".into()),
            from_ms: q.from_ms,
            to_ms: q.to_ms,
            max_points: 360,
        })
        .unwrap();
    let point = history
        .points
        .iter()
        .find(|p| p.time_ms <= t && t < p.time_ms + i64::from(p.duration_ms))
        .unwrap();
    assert_eq!((point.cpu_measured_ms, point.cpu_covered), (0, false));
    let own = history
        .coverage
        .iter()
        .filter(|c| c.container_id.is_some())
        .count();
    assert_eq!(
        own,
        api::MAX_COVERAGE_LISTED,
        "the newest of c's records are listed"
    );
    assert_eq!(history.coverage_total, 12_002);

    let events = r
        .events(&api::DockerEventsRequest {
            engine_id: "daemon".into(),
            container_id: None,
            from_ms: q.from_ms,
            to_ms: q.to_ms,
            limit: 100,
            before_id: None,
        })
        .unwrap();
    let reasons: Vec<_> = events.coverage.iter().map(|c| c.reason()).collect();
    assert_eq!(reasons, ["events_dropped_rate_limit"]);
}
