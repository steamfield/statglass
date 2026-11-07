use super::*;

#[test]
fn eviction_records_one_scoped_contiguous_permanent_loss() {
    let r = DockerRecorder::new(host().id);
    r.record(&fixture(10_000));
    r.record(&fixture(20_000));
    let mut s = r.state.lock_ok();
    evict(&mut s, HOUR + 20_000);
    let gaps = &s.retry.get("daemon").unwrap().coverage;
    let scoped: Vec<_> = gaps
        .iter()
        .filter(|g| g.entity.as_deref() == Some("c"))
        .collect();
    assert_eq!(scoped.len(), 1);
    assert_eq!((scoped[0].start_ms, scoped[0].end_ms), (0, Some(20_000)));
    assert_eq!(scoped[0].reason, "write_failed");
    evict(&mut s, HOUR + 30_000);
    assert_eq!(
        s.retry
            .get("daemon")
            .unwrap()
            .coverage
            .iter()
            .filter(|g| g.entity.as_deref() == Some("c"))
            .count(),
        1
    );
}

#[test]
fn aggregate_eviction_does_not_gap_durable_container_history() {
    let (_dir, store, r) = setup();
    r.record(&fixture(10_000));
    store.writer().flush().unwrap();
    {
        let mut s = r.state.lock_ok();
        drain(&mut s);
        let key = ("daemon".into(), String::new(), 0);
        let revision = next(&mut s);
        Arc::make_mut(&mut s.entries.get_mut(&key).unwrap().bucket).revision = revision;
        evict_entry(&mut s, &key);
    }
    r.record(&fixture(10_000));
    store.writer().flush().unwrap();
    let container = r.history(&query(0, 20_000, 10)).unwrap();
    assert!(!container.points.is_empty());
    assert!(
        container
            .coverage
            .iter()
            .all(|gap| gap.reason() != "write_failed"),
        "aggregate eviction must not invalidate durable container measurements"
    );
    let aggregate = r
        .history(&api::DockerHistoryRequest {
            container_id: None,
            ..query(0, 20_000, 10)
        })
        .unwrap();
    assert!(
        aggregate
            .coverage
            .iter()
            .any(|gap| gap.reason() == "write_failed" && gap.container_id.as_deref() == Some(""))
    );
    let comparison = r
        .comparison(&api::DockerComparisonRequest {
            engine_id: "daemon".into(),
            from_ms: 0,
            to_ms: 20_000,
            metric: api::DockerComparisonMetric::Cpu,
            project: None,
            selected: Some(vec!["c".into()]),
            max_points: 10,
        })
        .unwrap();
    assert_eq!(comparison.series.len(), 1);
    assert!(
        comparison
            .coverage
            .iter()
            .all(|gap| gap.reason() != "write_failed")
    );
}

#[test]
fn oversized_fresh_and_retry_payloads_drain_without_losing_evidence() {
    let (_dir, store, r) = setup();
    r.record(&fixture(10_000));
    store.writer().flush().unwrap();
    let (attached, _) = r.context();
    let mut s = r.state.lock_ok();
    drain(&mut s);
    let mut batch = r.batch(&mut s, "daemon", 1, 20_000);
    batch.entities.extend((0..100).map(|n| db::DockerEntity {
        external_id: format!("large{n}"),
        revision: batch.revision,
        name: "large".into(),
        extras: vec![b'x'; 16 * 1024],
        ..Default::default()
    }));
    batch.events.extend((0..500).map(|n| {
        db::DockerEvent {
            entity: None,
            time_ns: (n + 1) * 1_000_000,
            action: "start".into(),
            attributes: ["name", "image", "exitCode", "signal", "health_status"]
                .into_iter()
                .map(|key| (key.into(), "x".repeat(1024)))
                .collect(),
        }
    }));
    batch.coverage.extend((0..100).map(|n| db::DockerCoverage {
        entity: Some(format!("large{n}")),
        metric: None,
        start_ms: 0,
        end_ms: Some(1),
        reason: "event_replay_uncertain".into(),
        revision: batch.revision,
        sampled_ms: 0,
        expected_ms: 1,
    }));
    batch.cursor = Some(db::DockerCursor {
        time_ns: 500_000_000,
        event_key: batch.events.last().unwrap().key("daemon").unwrap(),
    });
    let seed = s
        .entries
        .get(&("daemon".into(), "c".into(), 0))
        .unwrap()
        .bucket
        .clone();
    for n in 0..1024 {
        let mut bucket = (*seed).clone();
        bucket.bucket_ms = n * 10_000;
        bucket.revision = batch.revision;
        let key = ("daemon".into(), "c".into(), bucket.bucket_ms);
        s.entries.insert(
            key,
            Entry {
                bytes: bucket_bytes(&bucket),
                bucket: Arc::new(bucket),
                pins: 0,
                durable: 0,
            },
        );
    }
    for attempt in 0..20 {
        let keys: Vec<_> = s
            .entries
            .iter()
            .filter(|(_, e)| e.pins == 0 && e.bucket.revision > e.durable)
            .map(|(key, _)| key.clone())
            .collect();
        batch.buckets = keys
            .iter()
            .map(|key| (*s.entries[key].bucket).clone())
            .collect();
        queue(&mut s, attached.as_ref(), batch, keys);
        assert!(
            s.error.is_none(),
            "valid rows must be split before admission: {:?}",
            s.error
        );
        assert!(!s.pending.is_empty());
        if s.retry
            .get("daemon")
            .is_some_and(|retry| !retry.events.is_empty() || !retry.coverage.is_empty())
        {
            assert!(
                s.pending.iter().all(|p| p.retry.cursor.is_none()),
                "cursor skips deferred evidence"
            );
        }
        if attempt == 0 {
            assert!(s.retry.contains_key("daemon"));
            assert!(
                s.entries
                    .values()
                    .any(|e| e.pins == 0 && e.bucket.revision > e.durable)
            );
        }
        drop(s);
        store.writer().flush().unwrap();
        s = r.state.lock_ok();
        drain(&mut s);
        assert!(s.error.is_none(), "{:?}", s.error);
        let conn = rusqlite::Connection::open(store.path()).unwrap();
        let events: i64 = conn
            .query_row("SELECT count(*) FROM docker_events", [], |row| row.get(0))
            .unwrap();
        let gaps: i64 = conn
            .query_row(
                "SELECT count(*) FROM docker_coverage WHERE reason='event_replay_uncertain'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let cursors: i64 = conn
            .query_row("SELECT count(*) FROM docker_event_cursors", [], |row| {
                row.get(0)
            })
            .unwrap();
        if cursors > 0 {
            assert_eq!((events, gaps), (500, 100));
        }
        if s.retry.is_empty() && s.entries.values().all(|e| e.bucket.revision <= e.durable) {
            assert!(attempt > 0, "oversized input must need multiple batches");
            assert_eq!((events, gaps, cursors), (500, 100, 1));
            let metadata: i64 = conn
                .query_row(
                    "SELECT count(*) FROM docker_metadata WHERE name='large'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(metadata, 100);
            let buckets: i64 = conn.query_row("SELECT count(*) FROM docker_10s b JOIN docker_entities e ON e.id=b.entity_id WHERE e.external_id='c'", [], |row| row.get(0)).unwrap();
            assert_eq!(buckets, 1024);
            return;
        }
        batch = r.batch(&mut s, "daemon", 1, 20_000);
    }
    panic!("retry did not drain");
}

#[test]
fn retry_events_are_bounded_and_warning_clock_is_per_engine() {
    let r = DockerRecorder::new(host().id);
    let mut s = r.state.lock_ok();
    let events = (0..4100)
        .map(|n| db::DockerEvent {
            entity: None,
            time_ns: n * 1_000_000,
            action: "start".into(),
            attributes: BTreeMap::new(),
        })
        .collect();
    requeue(
        &mut s,
        "a",
        Retry {
            events,
            ..Default::default()
        },
    );
    let retry = s.retry.get("a").unwrap();
    assert_eq!(retry.events.len(), 4096);
    assert_eq!(retry.coverage.len(), 1);
    assert_eq!(
        (retry.coverage[0].start_ms, retry.coverage[0].end_ms),
        (0, Some(4))
    );
    assert_eq!(retry.coverage[0].reason, "event_replay_uncertain");
    assert!(should_warn(&mut s, "a", 0));
    assert!(!should_warn(&mut s, "a", 59_999));
    assert!(should_warn(&mut s, "b", 59_999));
    assert!(should_warn(&mut s, "a", 60_000));
    requeue(
        &mut s,
        "b",
        Retry {
            events: (5000..5100)
                .map(|n| db::DockerEvent {
                    entity: None,
                    time_ns: n * 1_000_000,
                    action: "start".into(),
                    attributes: BTreeMap::new(),
                })
                .collect(),
            ..Default::default()
        },
    );
    assert_eq!(
        s.retry
            .values()
            .map(|retry| retry.events.len())
            .sum::<usize>(),
        4096
    );
    let mut delivered = 0;
    while let Some(engine) = s.retry.keys().next().cloned() {
        let batch = r.batch(&mut s, &engine, 1, 10_000);
        assert!(batch.events.len() <= 999);
        assert!(batch.logical_bytes().is_ok());
        delivered += batch.events.len();
    }
    assert_eq!(delivered, 4096);
}

#[test]
fn churn_accounts_for_metadata_and_engine_maps_and_expires_them() {
    let r = DockerRecorder::new(host().id);
    let t = wall_ms();
    let mut s = fixture(t);
    for i in 0..200 {
        s.engine.as_mut().unwrap().daemon_id = Some(format!("engine{i}"));
        s.containers[0].engine_id = format!("engine{i}");
        r.record(&s);
    }
    let mut state = r.state.lock_ok();
    assert!(state.aux_bytes > state.facts.len() * 512);
    evict(&mut state, t + HOUR + 60000);
    assert!(state.entries.is_empty());
    assert!(state.facts.is_empty());
    assert!(state.runtime.is_empty());
    assert!(state.bytes + state.aux_bytes + state.reader_bytes <= RING_BYTES);
}

#[test]
fn persisted_buckets_leave_the_ring_once_no_observation_can_reach_them() {
    let (_dir, store, r) = setup();
    r.record(&fixture(10_000));
    r.record(&fixture(20_000));
    store.writer().flush().unwrap();
    let mut s = r.state.lock_ok();
    drain(&mut s);
    let key = ("daemon".to_owned(), "c".to_owned(), 0);
    assert!(
        s.entries
            .get(&key)
            .is_some_and(|e| e.bucket.revision <= e.durable)
    );
    evict(&mut s, 10_000 + PERSISTED_KEEP_MS - 1);
    assert!(
        s.entries.contains_key(&key),
        "a late observation could still reach it"
    );
    evict(&mut s, 10_000 + PERSISTED_KEEP_MS);
    assert!(!s.entries.contains_key(&key));
    assert!(
        s.retry.is_empty(),
        "a persisted bucket leaves no loss behind"
    );
}

#[test]
fn unpersisted_buckets_stay_the_hour() {
    let r = DockerRecorder::new(host().id);
    r.record(&fixture(10_000));
    let mut s = r.state.lock_ok();
    let key = ("daemon".to_owned(), "c".to_owned(), 0);
    evict(&mut s, 10_000 + PERSISTED_KEEP_MS);
    assert!(s.entries.contains_key(&key));
}

#[test]
fn a_persisting_ring_holds_minutes_not_the_hour() {
    let (_dir, store, r) = setup();
    let mut snapshot = fixture(10_000);
    let template = snapshot.containers[0].clone();
    snapshot.containers = (0..30)
        .map(|n| {
            let mut c = template.clone();
            c.id = format!("c{n:02}");
            c
        })
        .collect();
    let mut peak = 0;
    for step in 1..=180 {
        let time = step * 10_000;
        at(&mut snapshot, time, 10_000);
        r.record(&snapshot);
        if time % 300_000 == 0 {
            store.writer().flush().unwrap();
        }
        peak = peak.max(r.state.lock_ok().bytes);
    }
    let per_bucket = {
        let s = r.state.lock_ok();
        s.bytes / s.entries.len()
    };
    let buckets = peak / per_bucket;
    eprintln!(
        "30 containers over 30 min, commit every 5 min: ring peak {peak} bytes, about {buckets} buckets"
    );
    // Five minutes uncommitted plus two persisted, per container and the aggregate.
    assert!(buckets <= 31 * (30 + 12 + 2), "{buckets} buckets held");
}

#[test]
fn bounding_coverage_never_turns_saving_or_events_records_into_a_gap() {
    let gap = |start: i64, end: Option<i64>, id: Option<&str>, reason: &str| {
        api::DockerCoverage::new(start, end, id.map(Into::into), reason.into())
    };
    let mut gaps: Vec<_> = (0..600)
        .map(|i| {
            let reason = if i % 2 == 0 {
                "write_failed"
            } else {
                "events_disconnected"
            };
            gap(i * 60_000, Some(i * 60_000 + 1000), None, reason)
        })
        .collect();
    // c lost two short intervals hours apart, and d's record is still open.
    gaps.push(gap(1_000_000, Some(1_001_000), Some("c"), "partial_cycle"));
    gaps.push(gap(
        20_000_000,
        Some(20_001_000),
        Some("c"),
        "partial_cycle",
    ));
    let open = gap(30_000_000, None, Some("d"), "partial_cycle");
    gaps.push(open.clone());
    bound_coverage(&mut gaps);
    assert!(gaps.len() <= 512, "{}", gaps.len());
    assert!(gaps.contains(&open));
    // Nothing engine-wide masks, and c's masking stays c's.
    assert!(!gaps.iter().any(|g| g.masks(None) || g.masks(Some("other"))));
    let masking_c: Vec<_> = gaps.iter().filter(|g| g.masks(Some("c"))).collect();
    assert!(
        masking_c
            .iter()
            .all(|g| g.start_ms >= 1_000_000 && g.end_ms <= Some(20_001_000)),
        "{masking_c:?}"
    );
    // The oldest records that mask nothing are the ones dropped.
    assert!(!gaps.iter().any(|g| g.start_ms == 0));
    // Too many of c's own records collapse into one span that masks only c.
    let mut gaps: Vec<_> = (0..600)
        .map(|i| gap(i * 1000, Some(i * 1000 + 500), Some("c"), "partial_cycle"))
        .collect();
    gaps.push(open.clone());
    bound_coverage(&mut gaps);
    assert_eq!(
        gaps,
        [open, gap(0, Some(599_500), Some("c"), "coverage_unknown")]
    );
}

#[test]
fn closed_coverage_leaves_memory_with_the_hour_and_is_not_readmitted() {
    let (_dir, store, r) = setup();
    let t = wall_ms().div_euclid(10_000) * 10_000 - 3 * HOUR;
    let mut s = fixture(t);
    s.coverage = vec![api::DockerCoverage::new(
        t - 1000,
        Some(t),
        Some("c".into()),
        "partial_cycle".into(),
    )];
    r.record(&s);
    assert_eq!(r.state.lock_ok().coverage["daemon"].len(), 1);
    store.writer().flush().unwrap();
    let saved = || {
        let mut reader = Reader::open(store.path()).unwrap();
        let snapshot = reader.docker_snapshot(host().id, "daemon").unwrap();
        snapshot
            .event_coverage(Some("c"), t - HOUR, t + 3 * HOUR)
            .unwrap()
    };
    let before = saved();
    // The published snapshot still carries it two hours later.
    for i in 0..3 {
        at(&mut s, t + 2 * HOUR + i * 1000, 1000);
        r.record(&s);
    }
    assert!(r.state.lock_ok().coverage["daemon"].is_empty());
    store.writer().flush().unwrap();
    assert_eq!(saved(), before, "the saved record was written again");
}
