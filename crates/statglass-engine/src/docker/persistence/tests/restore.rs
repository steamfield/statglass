use super::*;

#[test]
fn a_failed_restore_read_is_not_a_saving_failure() {
    let (dir, store, r) = setup();
    r.attach(store.writer(), dir.path().join("missing").join("h.sqlite"));
    r.record(&fixture(wall_ms()));
    assert!(r.state.lock_ok().restore_retry.contains_key("daemon"));
    assert_eq!(r.status().status, "recording");
    assert_eq!(r.status().error, None);
}

/// A restore that succeeds only after this process saved its own observations closes
/// the crashed process's open record no later than this process's first observation.
#[test]
fn a_late_restore_never_closes_a_crash_orphan_inside_this_session() {
    let (dir, store, crashed) = setup();
    let t = wall_ms().div_euclid(60_000) * 60_000 - 20 * 60_000;
    let mut s = fixture(t);
    s.coverage = vec![api::DockerCoverage::new(
        t + 1000,
        None,
        Some("c".into()),
        "partial_cycle".into(),
    )];
    crashed.record(&s);
    at(&mut s, t + 5000, 1000);
    crashed.record(&s);
    store.writer().flush().unwrap();
    drop(crashed);
    // The next process cannot read the store at first, but it saves.
    let r = DockerRecorder::new(host().id);
    r.attach(store.writer(), dir.path().join("missing").join("h.sqlite"));
    let first = t + 100_000;
    let mut s = fixture(first);
    for i in 0..60 {
        at(&mut s, first + i * 1000, 1000);
        r.record(&s);
    }
    store.writer().flush().unwrap();
    r.attach(store.writer(), store.path().to_path_buf());
    at(&mut s, first + 61_000, 1000);
    r.record(&s);
    let state = r.state.lock_ok();
    let closed: Vec<_> = state.coverage["daemon"]
        .iter()
        .filter(|g| g.reason() == "partial_cycle" && g.start_ms == t + 1000)
        .map(|g| g.end_ms)
        .collect();
    assert_eq!(closed, [Some(first)]);
}
