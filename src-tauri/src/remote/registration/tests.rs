use super::*;
use statglass_remote::ConnectionStatus;

#[test]
fn live_facts_emit_nothing_and_a_state_change_emits_once() {
    let manager = RemoteManager::default();
    let id = HostId(Uuid::nil());
    let generation = Uuid::new_v4();
    manager.generations.lock_ok().insert(id, generation);
    let mut status = ConnectionStatus {
        connected: true,
        ..Default::default()
    };
    publish_status(&manager, id, generation, status.clone(), true, None);
    let mut events = 0;
    for seen in 1..=20 {
        status.last_seen_ms = Some(seen);
        status.clock_offset_ms = seen;
        let mut statuses = manager.statuses.lock_ok();
        let previous = statuses.get_mut(&id).unwrap();
        previous.vitals.cpu_pct = Some(12.0);
        previous.vitals.memory_pct = Some(42.0);
        previous.vitals.load_1m = Some(1.5);
        drop(statuses);
        events += usize::from(publish_status(
            &manager,
            id,
            generation,
            status.clone(),
            true,
            None,
        ));
    }
    assert_eq!(
        events, 0,
        "live and polled facts must not notify hidden windows"
    );
    status.connected = false;
    events += usize::from(publish_status(
        &manager,
        id,
        generation,
        status.clone(),
        true,
        None,
    ));
    events += usize::from(publish_status(&manager, id, generation, status, true, None));
    assert_eq!(events, 1);
}

#[test]
fn a_stale_generation_cannot_complete_an_update() {
    let manager = RemoteManager::default();
    let id = HostId(Uuid::nil());
    let generation = Uuid::new_v4();
    manager.generations.lock_ok().insert(id, generation);
    let token = manager
        .begin_update(id, "1.0.0".into(), AgentUpdateVia::Push)
        .unwrap();
    manager.update_failed(id, token, &failure("upload failed"));
    let stale = Uuid::new_v4();
    let status = ConnectionStatus {
        connected: true,
        remote_version: Some("1.0.0".into()),
        ..Default::default()
    };
    for removed in [false, true] {
        if removed {
            manager.generations.lock_ok().remove(&id);
        }
        assert!(!publish_status(
            &manager,
            id,
            stale,
            status.clone(),
            true,
            None
        ));
        let mut observed = RemoteHostStatus::default();
        manager.apply_update(id, &mut observed);
        assert!(
            observed.last_update_failure.is_some(),
            "stale callback cleared update failure"
        );
    }
}

#[test]
fn accumulated_clock_steps_emit_once() {
    let manager = RemoteManager::default();
    let id = HostId(Uuid::nil());
    let generation = Uuid::new_v4();
    manager.generations.lock_ok().insert(id, generation);
    let mut status = ConnectionStatus {
        connected: true,
        ..Default::default()
    };
    assert!(publish_status(
        &manager,
        id,
        generation,
        status.clone(),
        false,
        None
    ));
    for offset in [400, 999, 1000, 1400, 1999, 2000, 1999, 1000] {
        status.clock_offset_ms = offset;
        assert_eq!(
            publish_status(&manager, id, generation, status.clone(), false, None),
            [1000, 2000].contains(&offset),
            "offset {offset}"
        );
    }
}

#[test]
fn rendered_sync_and_version_changes_emit_without_other_changes() {
    let previous = RemoteHostStatus::default();
    let mut next = previous.clone();
    next.sync = RemoteSync::CatchingUp;
    assert!(rendered_status_changed(&previous, &next, 0.0));
    next = previous.clone();
    next.agent_version = Some("0.0.9".into());
    assert!(rendered_status_changed(&previous, &next, 0.0));
    assert!(!rendered_status_changed(&next, &next, 0.0));
}

#[test]
fn every_new_failure_kind_crosses_the_boundary_with_its_routes() {
    use statglass_remote::{ConnectionFailureKind as K, Route, RouteFailure};
    let cases = [
        (K::NameNotResolved, RemoteFailureKind::NameNotResolved),
        (K::Refused, RemoteFailureKind::Refused),
        (K::NoRoute, RemoteFailureKind::NoRoute),
        (K::LocalOffline, RemoteFailureKind::LocalOffline),
        (K::TailscaleDown, RemoteFailureKind::TailscaleDown),
    ];
    for (kind, expected) in cases {
        let status = ConnectionStatus {
            retrying: true,
            error: Some("studio: failed".into()),
            failure_kind: Some(kind),
            route_failures: vec![
                RouteFailure {
                    route: Route::Lan,
                    kind: K::NameNotResolved,
                },
                RouteFailure {
                    route: Route::Tailscale,
                    kind,
                },
            ],
            ..Default::default()
        };
        let mapped = connection_status(status, false, None);
        assert_eq!(mapped.failure_kind, Some(expected));
        assert_eq!(
            mapped.route_failures,
            vec![
                RemoteRouteFailure {
                    route: RemoteRoute::Lan,
                    kind: RemoteFailureKind::NameNotResolved,
                },
                RemoteRouteFailure {
                    route: RemoteRoute::Tailscale,
                    kind: expected,
                },
            ]
        );
    }
}

#[test]
fn a_route_failure_change_re_emits_status() {
    use statglass_remote::{ConnectionFailureKind as K, Route, RouteFailure};
    let manager = RemoteManager::default();
    let id = HostId(Uuid::nil());
    let generation = Uuid::new_v4();
    manager.generations.lock_ok().insert(id, generation);
    let mut status = ConnectionStatus {
        retrying: true,
        error: Some("LAN: a; Tailscale: b".into()),
        failure_kind: Some(K::Timeout),
        route_failures: vec![RouteFailure {
            route: Route::Tailscale,
            kind: K::Timeout,
        }],
        ..Default::default()
    };
    publish_status(&manager, id, generation, status.clone(), false, None);
    status.route_failures[0].kind = K::NoRoute;
    assert!(publish_status(
        &manager, id, generation, status, false, None
    ));
}

#[test]
fn retry_schedule_crosses_the_boundary() {
    let status = ConnectionStatus {
        retrying: true,
        error: Some("timed out".into()),
        failure_kind: Some(statglass_remote::ConnectionFailureKind::Timeout),
        next_attempt_ms: Some(1_795_000_012_000),
        attempt: 3,
        dialing: false,
        waiting_for_network: false,
        ..Default::default()
    };
    let mapped = connection_status(status, false, None);
    assert_eq!(mapped.next_attempt_ms, Some(1_795_000_012_000.0));
    assert_eq!(mapped.attempt, 3);
    assert!(!mapped.dialing && !mapped.waiting_for_network);
    let waiting = connection_status(
        ConnectionStatus {
            retrying: true,
            dialing: true,
            waiting_for_network: true,
            ..Default::default()
        },
        false,
        None,
    );
    assert!(waiting.dialing && waiting.waiting_for_network);
}

#[test]
fn dialing_and_a_new_schedule_re_emit_but_the_attempt_count_alone_does_not() {
    let manager = RemoteManager::default();
    let id = HostId(Uuid::nil());
    let generation = Uuid::new_v4();
    manager.generations.lock_ok().insert(id, generation);
    let mut status = ConnectionStatus {
        retrying: true,
        error: Some("timed out".into()),
        failure_kind: Some(statglass_remote::ConnectionFailureKind::Timeout),
        next_attempt_ms: Some(1_000),
        attempt: 1,
        ..Default::default()
    };
    publish_status(&manager, id, generation, status.clone(), false, None);
    status.attempt = 2;
    assert!(!publish_status(
        &manager,
        id,
        generation,
        status.clone(),
        false,
        None
    ));
    status.dialing = true;
    status.next_attempt_ms = None;
    assert!(publish_status(
        &manager,
        id,
        generation,
        status.clone(),
        false,
        None
    ));
    status.dialing = false;
    status.next_attempt_ms = Some(5_000);
    assert!(publish_status(
        &manager,
        id,
        generation,
        status.clone(),
        false,
        None
    ));
    status.waiting_for_network = true;
    status.next_attempt_ms = None;
    assert!(publish_status(
        &manager, id, generation, status, false, None
    ));
}
