use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn id(n: u128) -> HostId {
    HostId(Uuid::from_u128(n))
}
fn job() -> RrJob {
    statglass_remote::rr::parse(br#"{"user":"alice","hostname":"client","started":"2026-11-10T12:00:00Z","command":"cargo test"}"#, "alice").unwrap()
}
fn connected(manager: &RemoteManager, host: HostId) -> Target {
    let generation = Uuid::new_v4();
    manager.rr_sessions.lock_ok().insert(host, generation);
    manager.statuses.lock_ok().insert(
        host,
        RemoteHostStatus {
            state: RemoteState::Connected,
            route: Some(RemoteRoute::Lan),
            ..Default::default()
        },
    );
    Target {
        host,
        generation,
        alias: "fake".into(),
    }
}
fn status(manager: &RemoteManager, host: HostId) -> RemoteHostStatus {
    let mut status = manager.statuses.lock_ok().get(&host).cloned().unwrap();
    manager.apply_rr(host, &mut status);
    status
}

#[tokio::test(start_paused = true)]
async fn cadence_is_owned_by_recent_interest_and_native_window_lifetime() {
    let registry = crate::live::LiveRegistry::new();
    let (tx, rx) = watch::channel(false);
    registry.observe_hosts_recent_interest(Arc::new(move |on| {
        tx.send_if_modified(|v| {
            let changed = *v != on;
            *v = on;
            changed
        });
    }));
    let (stop, stopped) = watch::channel(false);
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    let task = tokio::spawn(run(
        rx,
        stopped,
        move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            async {}
        },
        || {},
    ));
    tokio::time::advance(PERIOD * 2).await;
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    registry.window_visible("dashboard", true);
    registry.set_hosts_recent_interest("dashboard", true);
    tokio::task::yield_now().await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    tokio::time::advance(PERIOD - Duration::from_millis(1)).await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    registry.window_visible("dashboard", false);
    tokio::task::yield_now().await;
    tokio::time::advance(PERIOD * 2).await;
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    registry.window_visible("dashboard", true);
    tokio::task::yield_now().await;
    assert_eq!(reads.load(Ordering::SeqCst), 3);
    registry.page_loading("dashboard");
    tokio::task::yield_now().await;
    tokio::time::advance(PERIOD * 2).await;
    assert_eq!(reads.load(Ordering::SeqCst), 3);
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn interest_release_cancels_an_inflight_read() {
    struct Guard(Arc<AtomicUsize>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let (tx, rx) = watch::channel(true);
    let (stop, stopped) = watch::channel(false);
    let drops = Arc::new(AtomicUsize::new(0));
    let observed = drops.clone();
    let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        rx,
        stopped,
        move |_| {
            let guard = Guard(observed.clone());
            started.send(()).unwrap();
            async move {
                let _guard = guard;
                std::future::pending::<()>().await;
            }
        },
        || {},
    ));
    ready.recv().await.unwrap();
    tx.send(false).unwrap();
    tokio::task::yield_now().await;
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn only_enabled_connected_hosts_use_the_current_route() {
    let manager = RemoteManager::default();
    for (n, state, enabled) in [
        (1, RemoteState::Connected, true),
        (2, RemoteState::Offline, true),
        (3, RemoteState::Connecting, true),
        (4, RemoteState::Connected, false),
    ] {
        connected(&manager, id(n));
        manager.statuses.lock_ok().get_mut(&id(n)).unwrap().state = state;
        manager.saved.lock_ok().insert(
            id(n),
            SavedHost {
                config: RemoteHostConfig {
                    id: id(n).to_string(),
                    name: "test".into(),
                    lan: Some("lan".into()),
                    tailscale: Some("tail".into()),
                    enabled,
                    mirror_budget_mb: 100,
                },
                record: statglass_schema::HostRecord {
                    id: id(n),
                    is_local: false,
                    display_name: "test".into(),
                    info: statglass_schema::HostInfo {
                        os: statglass_schema::OsKind::Linux,
                        os_version: "test".into(),
                        model: None,
                        chip: None,
                        chip_known: false,
                        cpu_topology: vec![],
                        mem_total_bytes: 0,
                        boot_time_ms: 0,
                        kernel: None,
                        gpu_dvfs_mhz: vec![],
                        boot_mounts: vec![],
                    },
                },
                command: RemoteCommand::default(),
                last_agent_version: None,
            },
        );
    }
    let targets = manager.rr_targets();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].host, id(1));
    assert_eq!(targets[0].alias, "lan");
    manager.statuses.lock_ok().get_mut(&id(1)).unwrap().route = Some(RemoteRoute::Tailscale);
    assert_eq!(manager.rr_targets()[0].alias, "tail");
    let backoff = Mutex::new(Backoff::default());
    let reads = AtomicUsize::new(0);
    for state in [
        RemoteState::Offline,
        RemoteState::Connecting,
        RemoteState::Error,
        RemoteState::Disabled,
    ] {
        manager.statuses.lock_ok().get_mut(&id(1)).unwrap().state = state;
        backoff_tests::round(&manager, &backoff, manager.rr_targets(), &reads, true).await;
    }
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "disconnected saved hosts must never reach SSH"
    );
}

#[tokio::test(start_paused = true)]
async fn concurrent_reads_publish_changes_and_time_out_without_the_operation_lock() {
    let manager = RemoteManager::default();
    let first = connected(&manager, id(1));
    let second = connected(&manager, id(2));
    let stuck = connected(&manager, id(3));
    let _operation = manager.operation.lock().await;
    let changes = AtomicUsize::new(0);
    let published = tokio::sync::Notify::new();
    let changed = || {
        changes.fetch_add(1, Ordering::SeqCst);
        published.notify_one();
    };
    let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
    let backoff = Mutex::new(Backoff::default());
    let work = poll(
        &manager,
        id(0),
        vec![first.clone(), second, stuck],
        &backoff,
        |_| {
            let started = started.clone();
            async move {
                started.send(()).unwrap();
                std::future::pending::<statglass_remote::Result<Option<RrJob>>>().await
            }
        },
        async { Ok(Some(job())) },
        changed,
    );
    tokio::pin!(work);
    tokio::select! {
        () = &mut work => panic!("reads should be pending"),
        () = async {
            for _ in 0..3 { ready.recv().await.unwrap(); }
            published.notified().await;
        } => {},
    }
    assert!(
        manager.rr.lock_ok().contains_key(&id(0)),
        "local read is independent of SSH"
    );
    tokio::time::advance(CALL_TIMEOUT).await;
    work.await;
    assert_eq!(changes.load(Ordering::SeqCst), 1);
    manager.publish_rr(Some(&first), id(1), Some(job()), changed);
    assert_eq!(status(&manager, id(1)).rr.unwrap().peers, vec![id(0)]);
    assert_eq!(changes.load(Ordering::SeqCst), 2);
    manager.publish_rr(Some(&first), id(1), Some(job()), changed);
    assert_eq!(
        changes.load(Ordering::SeqCst),
        2,
        "unchanged reads emit nothing"
    );
    manager.statuses.lock_ok().get_mut(&id(1)).unwrap().state = RemoteState::Offline;
    manager.clear_rr(id(1));
    assert!(status(&manager, id(1)).rr.is_none());
    assert!(manager.rr.lock_ok()[&id(0)].peers.is_empty());
    connected(&manager, id(1));
    manager.publish_rr(Some(&first), id(1), Some(job()), changed);
    assert!(
        status(&manager, id(1)).rr.is_none(),
        "old connection result cannot repopulate a reconnect"
    );
}

#[tokio::test(start_paused = true)]
async fn a_stalled_local_read_does_not_block_subsequent_remote_rounds() {
    let manager = RemoteManager::default();
    let target = connected(&manager, id(1));
    let reads = AtomicUsize::new(0);
    let backoff = Mutex::new(Backoff::default());
    let round = || {
        poll(
            &manager,
            id(0),
            vec![target.clone()],
            &backoff,
            |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                async { Ok(Some(job())) }
            },
            std::future::pending(),
            || {},
        )
    };
    for _ in 0..2 {
        tokio::time::timeout(CALL_TIMEOUT + Duration::from_secs(1), round())
            .await
            .expect("a pending local read must not hold up the next remote poll");
    }
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert!(status(&manager, id(1)).rr.is_some());
}

#[tokio::test]
async fn timing_out_local_work_cannot_accumulate_blocking_readers() {
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (done, finished) = tokio::sync::oneshot::channel();
    let mut first = Box::pin(local_read(slots.clone(), move || {
        started.send(()).unwrap();
        wait.recv().unwrap();
        done.send(()).unwrap();
        Some(job())
    }));
    tokio::select! {
        result = &mut first => panic!("local read should still be pending: {result:?}"),
        () = async { ready.await.unwrap(); } => {},
    }
    // Drop the future just as the poll's timeout does, retaining the worker's permit.
    drop(first);
    let second_started = Arc::new(AtomicUsize::new(0));
    for _ in 0..3 {
        let reads = second_started.clone();
        assert!(
            local_read(slots.clone(), move || {
                reads.fetch_add(1, Ordering::SeqCst);
                Some(job())
            })
            .await
            .unwrap()
            .is_none()
        );
    }
    assert_eq!(second_started.load(Ordering::SeqCst), 0);
    release.send(()).unwrap();
    finished.await.unwrap();
}

#[path = "backoff_tests.rs"]
mod backoff_tests;

#[tokio::test(start_paused = true)]
async fn releasing_interest_clears_local_and_remote_jobs_and_notifies_once() {
    let manager = Arc::new(RemoteManager::default());
    let target = connected(&manager, id(1));
    manager.publish_rr(None, id(0), Some(job()), || {});
    manager.publish_rr(Some(&target), id(1), Some(job()), || {});
    let (interest, rx) = watch::channel(true);
    let (stop, stopped) = watch::channel(false);
    let observed = manager.clone();
    let changes = Arc::new(AtomicUsize::new(0));
    let notified = changes.clone();
    let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        rx,
        stopped,
        move |_| {
            started.send(()).unwrap();
            async {}
        },
        move || {
            observed.clear_rr_jobs(|| {
                notified.fetch_add(1, Ordering::SeqCst);
            })
        },
    ));
    ready.recv().await.unwrap();
    interest.send(false).unwrap();
    tokio::task::yield_now().await;
    assert!(
        manager.rr.lock_ok().is_empty(),
        "both local and remote jobs must be cleared"
    );
    assert_eq!(changes.load(Ordering::SeqCst), 1);
    interest.send(true).unwrap();
    ready.recv().await.unwrap();
    assert!(
        manager.rr.lock_ok().is_empty(),
        "a return visit must not show old jobs"
    );
    interest.send(false).unwrap();
    tokio::task::yield_now().await;
    assert_eq!(
        changes.load(Ordering::SeqCst),
        1,
        "clearing empty jobs emits nothing"
    );
    interest.send(true).unwrap();
    ready.recv().await.unwrap();
    manager.publish_rr(None, id(0), Some(job()), || {});
    interest.send(false).unwrap();
    interest.send(true).unwrap();
    ready.recv().await.unwrap();
    assert!(
        manager.rr.lock_ok().is_empty(),
        "a coalesced release/reacquire must also clear jobs"
    );
    assert_eq!(changes.load(Ordering::SeqCst), 2);
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn a_read_finishing_after_disconnect_and_reconnect_is_discarded() {
    let manager = RemoteManager::default();
    let target = connected(&manager, id(1));
    let (release, wait) = tokio::sync::oneshot::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let started = Mutex::new(Some(started));
    let wait = Mutex::new(Some(wait));
    let changes = AtomicUsize::new(0);
    let backoff = Mutex::new(Backoff::default());
    let work = poll(
        &manager,
        id(0),
        vec![target],
        &backoff,
        |_| {
            let wait = wait.lock_ok().take().unwrap();
            started.lock_ok().take().unwrap().send(()).unwrap();
            async move {
                wait.await.unwrap();
                Ok(Some(job()))
            }
        },
        async { Ok(None) },
        || {
            changes.fetch_add(1, Ordering::SeqCst);
        },
    );
    tokio::pin!(work);
    tokio::select! {
        () = &mut work => panic!("read should wait for release"),
        () = async { ready.await.unwrap(); } => {},
    }
    manager.statuses.lock_ok().get_mut(&id(1)).unwrap().state = RemoteState::Offline;
    manager.clear_rr(id(1));
    connected(&manager, id(1));
    release.send(()).unwrap();
    work.await;
    assert!(
        status(&manager, id(1)).rr.is_none(),
        "an old SSH read must not cross connection generations"
    );
    assert_eq!(changes.load(Ordering::SeqCst), 0);
}
