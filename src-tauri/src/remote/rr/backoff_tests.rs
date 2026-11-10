use super::*;

pub(super) async fn round(
    manager: &RemoteManager,
    backoff: &Mutex<Backoff>,
    targets: Vec<Target>,
    reads: &AtomicUsize,
    success: bool,
) {
    poll(
        manager,
        id(0),
        targets,
        backoff,
        |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            async move {
                if success {
                    Ok(Some(job()))
                } else {
                    Err(statglass_remote::RemoteError::Transport(
                        "Permission denied".into(),
                    ))
                }
            }
        },
        async { Ok(None) },
        || {},
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn failing_reads_wait_five_fifteen_then_sixty_minutes_and_success_resets() {
    let manager = RemoteManager::default();
    let target = connected(&manager, id(1));
    let backoff = Mutex::new(Backoff::default());
    let reads = AtomicUsize::new(0);
    round(&manager, &backoff, vec![target.clone()], &reads, false).await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    for (i, seconds) in [300, 900, 3600, 3600].into_iter().enumerate() {
        tokio::time::advance(Duration::from_secs(seconds) - Duration::from_millis(1)).await;
        round(&manager, &backoff, vec![target.clone()], &reads, false).await;
        assert_eq!(reads.load(Ordering::SeqCst), i + 1);
        tokio::time::advance(Duration::from_millis(1)).await;
        round(&manager, &backoff, vec![target.clone()], &reads, i == 3).await;
        assert_eq!(reads.load(Ordering::SeqCst), i + 2);
    }
    assert!(status(&manager, id(1)).rr.is_some());
    tokio::time::advance(PERIOD).await;
    round(&manager, &backoff, vec![target.clone()], &reads, false).await;
    assert!(status(&manager, id(1)).rr.is_none());
    tokio::time::advance(Duration::from_secs(299)).await;
    round(&manager, &backoff, vec![target.clone()], &reads, true).await;
    assert_eq!(reads.load(Ordering::SeqCst), 6);
    tokio::time::advance(Duration::from_secs(1)).await;
    round(&manager, &backoff, vec![target], &reads, true).await;
    assert_eq!(reads.load(Ordering::SeqCst), 7);
}

#[tokio::test(start_paused = true)]
async fn reconnect_resets_only_that_hosts_backoff() {
    let manager = RemoteManager::default();
    let first = connected(&manager, id(1));
    let second = connected(&manager, id(2));
    let backoff = Mutex::new(Backoff::default());
    let reads = AtomicUsize::new(0);
    round(
        &manager,
        &backoff,
        vec![first, second.clone()],
        &reads,
        false,
    )
    .await;
    manager.clear_rr(id(1));
    let reconnected = connected(&manager, id(1));
    round(&manager, &backoff, vec![reconnected, second], &reads, true).await;
    assert_eq!(reads.load(Ordering::SeqCst), 3);
    assert!(status(&manager, id(1)).rr.is_some());
    assert!(status(&manager, id(2)).rr.is_none());
}

#[tokio::test(start_paused = true)]
async fn interest_off_then_on_resets_failed_reads() {
    let manager = Arc::new(RemoteManager::default());
    let target = connected(&manager, id(1));
    let (interest, rx) = watch::channel(true);
    let (stop, stopped) = watch::channel(false);
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    let (done, mut rounds) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        rx,
        stopped,
        move |backoff| {
            let manager = manager.clone();
            let target = target.clone();
            let reads = observed.clone();
            let done = done.clone();
            async move {
                round(&manager, &backoff, vec![target], &reads, false).await;
                done.send(()).unwrap();
            }
        },
        || {},
    ));
    rounds.recv().await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    tokio::time::advance(PERIOD).await;
    rounds.recv().await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    interest.send(false).unwrap();
    tokio::task::yield_now().await;
    interest.send(true).unwrap();
    rounds.recv().await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn timeouts_back_off_and_an_empty_success_resets() {
    let manager = RemoteManager::default();
    let target = connected(&manager, id(1));
    let backoff = Mutex::new(Backoff::default());
    poll(
        &manager,
        id(0),
        vec![target.clone()],
        &backoff,
        |_| std::future::pending(),
        async { Ok(None) },
        || {},
    )
    .await;
    let reads = AtomicUsize::new(0);
    round(&manager, &backoff, vec![target.clone()], &reads, true).await;
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    tokio::time::advance(Duration::from_secs(300)).await;
    poll(
        &manager,
        id(0),
        vec![target.clone()],
        &backoff,
        |_| async { Ok(None) },
        async { Ok(None) },
        || {},
    )
    .await;
    tokio::time::advance(PERIOD).await;
    round(&manager, &backoff, vec![target], &reads, true).await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}
