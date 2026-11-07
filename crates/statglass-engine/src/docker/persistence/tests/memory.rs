use super::*;

/// Six containers flap for 200 s while the store commits every 300 s: more than 512
/// closed records wait on writes. Memory lets them go, reads merge the writes, and no
/// record collapses into a span that masks the good seconds between failures.
#[test]
fn unsaved_records_of_flapping_containers_are_never_collapsed() {
    use crate::docker::publication::{bound_published, reconcile_partial};
    let (_dir, store, r) = setup();
    let t = wall_ms().div_euclid(60_000) * 60_000 - 30 * 60_000;
    let mut s = fixture(t);
    let template = s.containers[0].clone();
    s.containers = (0..6)
        .map(|n| {
            let mut c = template.clone();
            c.id = format!("c{n}");
            c
        })
        .collect();
    let ids: BTreeSet<String> = s.containers.iter().map(|c| c.id.clone()).collect();
    let mut coverage = Vec::new();
    for i in 0..=200 {
        let time = t + i * 1000;
        let failing = if i % 2 == 1 {
            ids.clone()
        } else {
            BTreeSet::new()
        };
        at(&mut s, time, 1000);
        for c in &mut s.containers {
            if failing.contains(&c.id) {
                c.observed_ms = None;
            }
        }
        reconcile_partial(&mut coverage, &failing, time);
        bound_published(&mut coverage);
        s.coverage = coverage.clone();
        r.record(&s);
    }
    let measured = |recorder: &DockerRecorder| -> Vec<_> {
        let mut q = query(t, t + 200_000, 100);
        q.container_id = Some("c0".into());
        let page = recorder.history(&q).unwrap();
        assert!(
            page.coverage.iter().all(|g| g.reason() == "partial_cycle"),
            "a record collapsed"
        );
        page.points
            .iter()
            .map(|p| (p.time_ms, p.cpu_measured_ms))
            .collect()
    };
    let live = measured(&r);
    assert!(live.iter().skip(1).all(|(_, cpu)| *cpu > 0), "{live:?}");
    assert!(r.state.lock_ok().coverage["daemon"].len() <= 512);
    // Everything waiting reaches the store; a store-only reader gives the same answer.
    for k in 0..4 {
        store.writer().flush().unwrap();
        s.coverage.clear();
        at(&mut s, t + 300_000 + k * 1000, 1000);
        r.record(&s);
    }
    store.writer().flush().unwrap();
    let store_only = DockerRecorder::new(host().id);
    store_only.attach(store.writer(), store.path().to_path_buf());
    assert_eq!(measured(&store_only), live);
}

/// A recorder-found interruption merges only into the same reason's open or touching
/// record, and it is saved.
#[test]
fn recorder_gaps_merge_only_when_they_touch_and_are_saved() {
    let (_dir, store, r) = setup();
    let t = wall_ms().div_euclid(10_000) * 10_000 - 2 * HOUR;
    let mut s = fixture(t);
    r.record(&s);
    {
        let mut state = r.state.lock_ok();
        gap(&mut state, "daemon", t, t + 1000, "ring_capacity");
        gap(&mut state, "daemon", t + 1000, t + 2000, "ring_capacity");
        gap(
            &mut state,
            "daemon",
            t + HOUR / 2,
            t + HOUR / 2 + 1000,
            "ring_capacity",
        );
    }
    at(&mut s, t + HOUR / 2 + 2000, 1000);
    r.record(&s);
    store.writer().flush().unwrap();
    let conn = rusqlite::Connection::open(store.path()).unwrap();
    let rows: Vec<(i64, Option<i64>)> = conn
        .prepare(
            "SELECT start_ms,end_ms FROM docker_coverage WHERE reason='ring_capacity' ORDER BY start_ms",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            (t, Some(t + 2000)),
            (t + HOUR / 2, Some(t + HOUR / 2 + 1000))
        ]
    );
}
