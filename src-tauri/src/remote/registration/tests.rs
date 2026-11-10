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
