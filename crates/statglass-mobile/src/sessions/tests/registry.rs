use std::fs;
use std::os::unix::fs::PermissionsExt;

use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileConfig, MobileHostKey};
use statglass_schema::HostRecord;
use statglass_session::{ConnectionFailureKind, ConnectionStatus, Route};
use statglass_ssh::SoftwareSigner;

use crate::control::SessionControl;
use statglass_engine::Source;

use super::*;

#[tokio::test]
async fn phone_identity_is_private_stable_and_never_replaces_a_corrupt_file() {
    let fixture = Fixture::start(vec![], SyncPolicy::Off);
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let start = |sessions: &Sessions| {
        sessions.start(
            Handle::current(),
            data.clone(),
            MobileConfig::default(),
            Arc::new(SoftwareSigner::generate()),
            SyncPolicy::Off,
        )
    };

    let first = Sessions::new(fixture.events.clone());
    start(&first).unwrap();
    let path = data.join("phone-id");
    let original = fs::read_to_string(&path).unwrap();
    let _: HostId = HostId(original.trim().parse().unwrap());
    assert_eq!(
        fs::metadata(&data).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(matches!(
        start(&first),
        Err(CommandError::InvalidArgument { .. })
    ));
    drop(first);

    let second = Sessions::new(fixture.events.clone());
    start(&second).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    drop(second);

    fs::write(&path, "broken").unwrap();
    let third = Sessions::new(fixture.events.clone());
    let error = start(&third).unwrap_err();
    assert!(error.to_string().contains("invalid phone identity"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
}

#[tokio::test(start_paused = true)]
async fn empty_and_invalid_host_lists_leave_the_current_roster_intact() {
    let fixture = Fixture::start(vec![], SyncPolicy::Off);
    let sessions = &fixture.sessions;
    let first = host(2);
    let second = host(1);
    for list in [MobileCall::ListHosts, MobileCall::ListRemoteHosts] {
        assert_eq!(sessions.call(list).await.unwrap(), json!([]));
    }
    for request in [
        MobileCall::GetHost { host: first.id },
        MobileCall::GetCapabilities { host: first.id },
        MobileCall::RetryRemoteHost { host: first.id },
        MobileCall::HostVitals { host: first.id },
        subscribe(first.id, 42),
        MobileCall::QueryEvents {
            host: first.id,
            from_ms: NOW,
            to_ms: NOW + 1,
        },
    ] {
        assert_eq!(
            sessions.call(request).await,
            Err(CommandError::UnknownHost { host: first.id })
        );
    }
    fixture.events.events.lock_ok().clear();
    sessions
        .set_hosts(vec![first.clone(), second.clone()], SyncPolicy::Off)
        .unwrap();
    assert_eq!(
        *fixture.events.events.lock_ok(),
        vec![
            json!({"kind": "hosts_changed", "hosts": [endpoint::record(&first), endpoint::record(&second)]}),
            remote_changed(),
        ]
    );
    let mut no_target = first.clone();
    no_target.targets.clear();
    let mut no_user = first.clone();
    no_user.user.clear();
    for hosts in [
        vec![no_target],
        vec![no_user],
        vec![second.clone(), second.clone()],
    ] {
        assert!(matches!(
            sessions.set_hosts(hosts, SyncPolicy::Off),
            Err(CommandError::InvalidArgument { .. })
        ));
        assert_eq!(
            ids(sessions.call(MobileCall::ListHosts).await.unwrap()),
            vec![first.id, second.id]
        );
    }
    assert_eq!(fixture.events.events.lock_ok().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn removing_a_host_closes_the_session_and_keeps_the_private_mirror() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let mut dial = fixture.next_dial().await;
    dial.handshake(&host).await;
    fixture.sessions.call(subscribe(host.id, 9)).await.unwrap();
    assert_eq!(fixture.message("caps").await.0, 9);

    fixture.sessions.set_hosts(vec![], SyncPolicy::Off).unwrap();
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::GetHost { host: host.id })
            .await,
        Err(CommandError::UnknownHost { host: host.id })
    );
    assert_eq!(fixture.sessions.registry.live.open_host(), None);
    timeout(WAIT, &mut dial.closing)
        .await
        .unwrap()
        .expect("removed host quiesces");
    assert_eq!(
        fixture
            .sessions
            .sources()
            .iter()
            .map(|source| source.host().id)
            .collect::<Vec<_>>(),
        [host.id],
        "the lifecycle drain still sees a closing source"
    );
    dial.finish_close.send(()).unwrap();
    let mirror = fixture.dir.path().join("mirrors").join(host.id.to_string());
    assert_eq!(
        fs::metadata(&mirror).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(mirror.join(statglass_engine::HISTORY_DB_FILE).is_file());
}

#[tokio::test(start_paused = true)]
async fn replacement_waits_for_the_old_transport_and_uses_the_latest_host_list() {
    let original = host(1);
    let mut fixture = Fixture::start(vec![original.clone()], SyncPolicy::Off);
    let mut old = fixture.next_dial().await;
    old.handshake(&original).await;
    let mut replacement = original.clone();
    replacement.name = "Updated host".into();
    replacement.targets[0].host = "intermediate.local".into();
    fixture
        .sessions
        .set_hosts(vec![replacement.clone()], SyncPolicy::Off)
        .unwrap();
    timeout(WAIT, &mut old.closing)
        .await
        .unwrap()
        .expect("old source reaches orderly close");
    let served: HostRecord = serde_json::from_value(
        fixture
            .sessions
            .call(MobileCall::GetHost { host: original.id })
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(served.display_name, original.name);
    assert!(
        fixture.dials.try_recv().is_err(),
        "new source must wait for close"
    );

    replacement.targets[0].host = "latest.local".into();
    fixture
        .sessions
        .set_hosts(vec![replacement.clone()], SyncPolicy::Off)
        .unwrap();
    assert!(
        fixture.dials.try_recv().is_err(),
        "one replacement owns the mirror"
    );
    old.finish_close.send(()).unwrap();
    let mut new = fixture.next_dial().await;
    assert_eq!(new.target, "latest.local");
    new.handshake(&replacement).await;
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::GetHost { host: original.id })
            .await
            .unwrap(),
        json!(endpoint::record(&replacement)),
    );
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::QueryEvents {
                host: original.id,
                from_ms: NOW,
                to_ms: NOW + 1,
            })
            .await
            .unwrap(),
        json!([]),
        "replacement can read its reopened mirror"
    );
}

#[test]
fn endpoint_uses_the_desktop_command_lines_in_target_order_with_pinned_keys() {
    let mut host = host(1);
    host.port = Some(2222);
    host.targets.insert(
        0,
        MobileTarget {
            route: RemoteRoute::Tailscale,
            host: "node.tailnet".into(),
        },
    );
    host.host_keys.push(MobileHostKey {
        algorithm: "ssh-ed25519".into(),
        sha256: "SHA256:fixture".into(),
    });
    for (command, desktop) in [
        (MobileCommand::Restricted, "serve"),
        (
            MobileCommand::MacHelper {
                path: "/a path/remote-helper".into(),
            },
            "exec '/a path/remote-helper' serve --stdio",
        ),
        (
            MobileCommand::MacHelper {
                path: String::new(),
            },
            r#"exec "$HOME"/Applications/StatGlass.app/Contents/MacOS/statglass-remote-helper serve --stdio"#,
        ),
        (
            MobileCommand::Agent {
                bin: "/srv/agent".into(),
                system: true,
                socket: Some("/run/agent.sock".into()),
            },
            r#"exec /bin/sh -c 'exec "/srv/agent" serve --stdio --system --socket "/run/agent.sock"'"#,
        ),
    ] {
        host.command = command;
        let endpoint = endpoint::endpoint(&host);
        assert_eq!(endpoint.command.serve_command().unwrap(), desktop);
        assert_eq!(endpoint.port, Some(2222));
        assert_eq!(endpoint.user.as_deref(), Some("monitor"));
        assert_eq!(
            endpoint.targets,
            [
                Target {
                    route: Route::Tailscale,
                    host: "node.tailnet".into()
                },
                Target {
                    route: Route::Lan,
                    host: "mac1.local".into()
                },
            ]
        );
        assert_eq!(
            endpoint.host_keys,
            [statglass_session::PinnedHostKey {
                algorithm: "ssh-ed25519".into(),
                sha256: "SHA256:fixture".into(),
            }]
        );
    }
}

#[tokio::test(start_paused = true)]
async fn remote_status_uses_the_scaffold_json_and_does_not_repeat_unchanged_events() {
    let host = host(1);
    let fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let entry = fixture.sessions.registry.entry(host.id).unwrap();
    entry.source.quiesce().await;
    timeout(WAIT, async {
        loop {
            let published = fixture
                .events
                .events
                .lock_ok()
                .iter()
                .filter(|event| event["kind"] == "remote_hosts_changed")
                .count();
            if published >= 2 {
                break;
            }
            fixture.events.event_ready.notified().await;
        }
    })
    .await
    .unwrap();
    fixture.events.events.lock_ok().clear();
    let status = ConnectionStatus {
        connected: false,
        route: Some(Route::Tailscale),
        last_seen_ms: Some(NOW),
        error: Some("access denied".into()),
        failure_kind: Some(ConnectionFailureKind::Authentication),
        remote_version: Some("1.3.0".into()),
        identity_changed: Some(super::host(2).id),
        clock_offset_ms: 15,
        ..Default::default()
    };
    for update in [status.clone(), status] {
        if let Some(check) =
            entry.observe_status(update, &Handle::current(), fixture.events.clone())
        {
            check.await.unwrap();
        }
    }
    assert!(
        timeout(Duration::from_millis(20), async {
            loop {
                if fixture.events.events.lock_ok().len() > 1 {
                    return;
                }
                fixture.events.event_ready.notified().await;
            }
        })
        .await
        .is_err()
    );
    assert_eq!(*fixture.events.events.lock_ok(), [remote_changed()]);
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::ListRemoteHosts)
            .await
            .unwrap(),
        json!([{
            "id": host.id, "name": host.name, "os": "mac_os", "targets": host.targets,
            "mirror_budget_mb": crate::policy::host_budget_mb(1),
            "connection": {
                "state": "error", "route": "tailscale", "sync": "idle",
                "failure": "authentication", "message": "access denied", "route_failures": [],
            },
        "last_seen_ms": NOW + 15, "synced_through_ms": null, "next_attempt_ms": null,
            "attempt": 0, "dialing": false, "waiting_for_network": false, "clock_offset_ms": 15,
            "vitals": statglass_ipc::vitals::HostVitals::default(), "agent_version": "1.3.0",
            "identity_changed": super::host(2).id,
        }])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_sets_deliver_rosters_in_order() {
    let fixture = Fixture::start(vec![], SyncPolicy::Off);
    let first = host(1);
    let second = host(2);
    fixture.events.events.lock_ok().clear();
    let (gate, entered, release) = CallbackGate::new();
    *fixture.events.event_gate.lock_ok() = Some(gate);
    let sessions = Arc::new(fixture.sessions);
    let earlier = tokio::task::spawn_blocking({
        let (sessions, first) = (sessions.clone(), first.clone());
        move || sessions.set_hosts(vec![first], SyncPolicy::Off).unwrap()
    });
    timeout(WAIT, entered).await.unwrap().unwrap();
    sessions
        .set_hosts(vec![first.clone(), second.clone()], SyncPolicy::Off)
        .unwrap();
    release.send(()).unwrap();
    earlier.await.unwrap();
    let rosters: Vec<_> = fixture
        .events
        .events
        .lock_ok()
        .iter()
        .filter(|event| event["kind"] == "hosts_changed")
        .map(|event| ids(event["hosts"].clone()))
        .collect();
    assert_eq!(rosters, [vec![first.id], vec![first.id, second.id]]);
}

#[tokio::test(start_paused = true)]
async fn retry_recovers_a_configured_host_after_its_mirror_directory_recovers() {
    let original = host(1);
    let mut fixture = Fixture::start(vec![original.clone()], SyncPolicy::Off);
    let mut dial = fixture.next_dial().await;
    dial.handshake(&original).await;
    let mut updated = original.clone();
    updated.name = "Updated host".into();
    fixture
        .sessions
        .set_hosts(vec![updated.clone()], SyncPolicy::Off)
        .unwrap();
    timeout(WAIT, &mut dial.closing).await.unwrap().unwrap();
    fixture.events.events.lock_ok().clear();
    let path = fixture
        .dir
        .path()
        .join("mirrors")
        .join(original.id.to_string());
    let saved = path.with_extension("saved");
    fs::rename(&path, &saved).unwrap();
    fs::write(&path, "temporarily unavailable").unwrap();
    dial.finish_close.send(()).unwrap();
    assert_eq!(fixture.next_roster().await, [original.id]);
    assert_eq!(
        fixture.sessions.call(MobileCall::ListHosts).await.unwrap(),
        json!([endpoint::record(&updated)])
    );
    let failed = fixture
        .sessions
        .call(MobileCall::ListRemoteHosts)
        .await
        .unwrap();
    assert_eq!(failed[0]["id"], json!(original.id));
    assert_eq!(failed[0]["connection"]["state"], "error");
    assert!(
        failed[0]["connection"]["message"]
            .as_str()
            .unwrap()
            .contains("creating mirror directory")
    );
    fs::remove_file(&path).unwrap();
    fs::rename(saved, path).unwrap();
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::RetryRemoteHost { host: original.id })
            .await
            .unwrap(),
        Value::Null
    );
    let mut dial = fixture.next_dial().await;
    dial.handshake(&updated).await;
    assert_eq!(
        ids(fixture.sessions.call(MobileCall::ListHosts).await.unwrap()),
        [original.id]
    );
}

#[tokio::test(start_paused = true)]
async fn startup_lists_a_failed_host_with_its_error_alongside_healthy_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let failed = host(1);
    let healthy = host(2);
    let mirrors = dir.path().join("mirrors");
    fs::create_dir(&mirrors).unwrap();
    fs::write(
        mirrors.join(failed.id.to_string()),
        "cannot open a directory here",
    )
    .unwrap();
    let mut fixture =
        Fixture::start_in(dir, vec![failed.clone(), healthy.clone()], SyncPolicy::Off);
    let mut peer = fixture.next_dial().await;
    assert_eq!(peer.target, healthy.targets[0].host);
    peer.handshake(&healthy).await;
    assert_eq!(
        ids(fixture.sessions.call(MobileCall::ListHosts).await.unwrap()),
        [failed.id, healthy.id]
    );
    let rows = fixture
        .sessions
        .call(MobileCall::ListRemoteHosts)
        .await
        .unwrap();
    assert_eq!(rows[0]["id"], json!(failed.id));
    assert_eq!(rows[0]["connection"]["state"], "error");
    assert!(
        rows[0]["connection"]["message"]
            .as_str()
            .unwrap()
            .contains("creating mirror directory")
    );
    assert_eq!(rows[1]["connection"]["state"], "connected");
}

#[tokio::test(start_paused = true)]
async fn growing_from_two_to_eleven_hosts_rebuilds_the_old_mirrors_at_the_new_budget() {
    let hosts: Vec<_> = (1..=11).map(host).collect();
    let mut fixture = Fixture::start(hosts[..2].to_vec(), SyncPolicy::Off);
    let mut old = Vec::new();
    for _ in 0..2 {
        let mut dial = fixture.next_dial().await;
        let host = hosts
            .iter()
            .find(|host| host.targets[0].host == dial.target)
            .unwrap();
        dial.handshake(host).await;
        old.push(dial);
    }
    let budgets = |rows: Value| {
        rows.as_array()
            .unwrap()
            .iter()
            .map(|row| row["mirror_budget_mb"].as_u64().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        budgets(
            fixture
                .sessions
                .call(MobileCall::ListRemoteHosts)
                .await
                .unwrap()
        ),
        vec![u64::from(crate::policy::host_budget_mb(2)); 2]
    );

    fixture
        .sessions
        .set_hosts(hosts.clone(), SyncPolicy::Off)
        .unwrap();
    for dial in &mut old {
        timeout(WAIT, &mut dial.closing)
            .await
            .unwrap()
            .expect("old dial closes orderly");
    }
    let mut new = Vec::new();
    for _ in 0..9 {
        let dial = fixture.next_dial().await;
        assert!(old.iter().all(|old| old.target != dial.target));
        new.push(dial);
    }
    assert!(
        fixture.dials.try_recv().is_err(),
        "neither old host can dial before closing"
    );
    for dial in old {
        dial.finish_close.send(()).unwrap();
        let replacement = fixture.next_dial().await;
        assert_eq!(replacement.target, dial.target);
        new.push(replacement);
    }
    assert_eq!(
        budgets(
            fixture
                .sessions
                .call(MobileCall::ListRemoteHosts)
                .await
                .unwrap()
        ),
        vec![u64::from(crate::policy::host_budget_mb(11)); 11]
    );
}
