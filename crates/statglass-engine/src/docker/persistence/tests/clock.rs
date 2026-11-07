use super::*;
use crate::docker::DockerHandle;
use crate::docker::worker::clock_stepped;

fn handle() -> DockerHandle {
    DockerHandle::new(host().id, api::DockerSettings::default(), PathBuf::new())
}
/// The measured CPU time of `c` in the ring, per bucket.
fn weights(handle: &DockerHandle) -> Vec<(i64, u64)> {
    let s = handle.recorder.state.lock_ok();
    s.entries
        .iter()
        .filter(|((_, id, _), _)| id == "c")
        .map(|((_, _, time), e)| {
            let cpu = e.bucket.metrics.iter().find(|m| m.key == "cpu_percent");
            (*time, cpu.map_or(0, |m| m.weight_ms))
        })
        .collect()
}

#[test]
fn a_forward_step_never_records_the_last_observation_twice() {
    let handle = handle();
    let t = wall_ms().div_euclid(10_000) * 10_000 - HOUR + 5_000;
    handle.publish(fixture(t));
    let before = weights(&handle);
    assert_eq!(before, [(t - 5_000, 1000)]);
    handle.step_clock(t + HOUR / 2);
    assert_eq!(
        weights(&handle),
        before,
        "the step re-recorded its snapshot"
    );
}

#[test]
fn a_backward_step_recreates_nothing_after_it_and_keeps_real_observations() {
    let handle = handle();
    let t = wall_ms().div_euclid(10_000) * 10_000 - HOUR + 5_000;
    handle.publish(fixture(t + 30_000));
    handle.step_clock(t + 10_000);
    assert!(weights(&handle).is_empty(), "{:?}", weights(&handle));
    // The next real cycle, on the corrected clock.
    let mut s = handle.snapshot();
    let mut later = fixture(t + 11_000);
    later.coverage = std::mem::take(&mut s.coverage);
    handle.publish(later);
    assert_eq!(weights(&handle), [(t + 5_000, 1000)]);
}

#[test]
fn a_sleep_is_not_a_clock_step() {
    let at = |wall_ms: i64, continuous_s: u64| crate::ClockReading {
        wall_ms,
        continuous_ns: continuous_s * 1_000_000_000,
    };
    let before = at(1_000_000, 100);
    // An hour asleep: wall time and the sleep-counting clock both moved an hour.
    assert!(!clock_stepped(&before, &at(1_000_000 + HOUR, 100 + 3600)));
    // The wall clock moved an hour in one second, either way.
    assert!(clock_stepped(&before, &at(1_000_000 + HOUR, 101)));
    assert!(clock_stepped(&before, &at(1_000_000 - HOUR, 101)));
    assert!(!clock_stepped(&before, &at(1_001_500, 101)));
}

/// The clock baseline outlives a session: a step while disconnected, idle or backing
/// off is seen by the next session's first cycle.
#[test]
fn a_step_between_sessions_is_still_a_step() {
    let handle = handle();
    let t = wall_ms().div_euclid(10_000) * 10_000 - HOUR + 5_000;
    let at = |wall_ms: i64, continuous_s: u64| crate::ClockReading {
        wall_ms,
        continuous_ns: continuous_s * 1_000_000_000,
    };
    // The last cycle of one session.
    handle.check_clock(at(t, 100), &mut crate::docker::sampling::Samples::new(), 1);
    // A minute later the next session's first cycle reads a clock set back 30 s.
    handle.check_clock(
        at(t + 30_000, 160),
        &mut crate::docker::sampling::Samples::new(),
        1,
    );
    let steps: Vec<_> = handle
        .snapshot()
        .coverage
        .iter()
        .filter(|c| c.reason() == "clock_step")
        .map(|c| c.start_ms)
        .collect();
    assert_eq!(steps, [t + 30_000]);
}

#[test]
fn a_step_truncates_retried_and_in_flight_writes() {
    let r = DockerRecorder::new(host().id);
    let t = 1_000_000;
    let row = |start: i64, end: Option<i64>| db::DockerCoverage {
        entity: Some("c".into()),
        metric: None,
        start_ms: start,
        end_ms: end,
        reason: "partial_cycle".into(),
        revision: 1,
        sampled_ms: 0,
        expected_ms: end.map_or(0, |end| end - start),
    };
    let event = |ms: i64| db::DockerEvent {
        entity: None,
        time_ns: ms * 1_000_000,
        action: "start".into(),
        attributes: BTreeMap::new(),
    };
    let (ack, rx) = mpsc::channel();
    {
        let mut s = r.state.lock_ok();
        s.retry.insert(
            "daemon".into(),
            Retry {
                coverage: vec![row(t, Some(t + 20_000)), row(t + 15_000, None)],
                events: vec![event(t + 1_000), event(t + 12_000)],
                ..Retry::default()
            },
        );
        s.pending.push(Receipt {
            rx,
            retry: Retry {
                coverage: vec![row(t, Some(t + 30_000))],
                ..Retry::default()
            },
            keys: Vec::new(),
            engine: "daemon".into(),
            start: t,
            end: t + 30_000,
        });
    }
    r.clock_step(t + 10_000);
    // The in-flight write fails after the step and comes back as a retry.
    ack.send(db::DockerAck {
        generation: 0,
        revision: 1,
        outcome: db::DockerOutcome::Failed,
        reason: None,
    })
    .unwrap();
    let mut s = r.state.lock_ok();
    drain(&mut s);
    let retry = &s.retry["daemon"];
    let ends: Vec<_> = retry
        .coverage
        .iter()
        .map(|c| (c.start_ms, c.end_ms))
        .collect();
    assert_eq!(
        ends,
        [(t, Some(t + 10_000))],
        "a retry re-extended past the step"
    );
    let events: Vec<_> = retry.events.iter().map(|e| e.time_ns / 1_000_000).collect();
    assert_eq!(events, [t + 1_000]);
}
