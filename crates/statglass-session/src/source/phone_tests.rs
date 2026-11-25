use super::*;
use crate::{
    APP_NOT_RUNNING, BoxFuture, Close, DialFailure, DialedStream, MONITORING_OFF, MirrorError,
    StderrTail, Target,
    network::{LocalNetwork, UNKNOWN_NETWORK},
    test_support::{endpoint, fixture_hello},
};
use statglass_proto::{HostSummary, SourceStatus, SyncPage, SyncRequest, WireBucket, WireLayout};
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncWrite, DuplexStream, WriteHalf},
    sync::{Notify, mpsc, oneshot},
    time::{advance, timeout},
};

const WAIT: Duration = Duration::from_secs(3);
const PHONE_TIERS: &[Tier] = &[Tier::M1, Tier::M15];
const DESKTOP_TIERS: &[Tier] = &[Tier::S10, Tier::M1, Tier::M15];
const BOTH_UP: LocalNetwork = LocalNetwork {
    online: true,
    lan_up: true,
    tailscale_up: true,
};

struct Dial {
    peer: DuplexStream,
    at: Instant,
    closed: oneshot::Receiver<()>,
    target: Target,
    stderr: StderrTail,
    writes: Arc<WriteGate>,
}

struct WriteGate {
    remaining: AtomicU32,
    stalled: Notify,
}

struct GateWriter(WriteHalf<DuplexStream>, Arc<WriteGate>);

impl AsyncWrite for GateWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self
            .1
            .remaining
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
            .is_err()
        {
            self.1.stalled.notify_one();
            return Poll::Pending;
        }
        Pin::new(&mut self.0).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

struct PhoneDialer(mpsc::UnboundedSender<Dial>);

struct CloseSignal(oneshot::Sender<()>);

impl Close for CloseSignal {
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let _ = self.0.send(());
        })
    }
}

impl Dialer for PhoneDialer {
    fn dial<'a>(
        &'a self,
        _: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, Result<DialedStream>> {
        Box::pin(async move {
            let (client, peer) = tokio::io::duplex(65536);
            let (close, closed) = oneshot::channel();
            let stderr = StderrTail::default();
            let writes = Arc::new(WriteGate {
                remaining: AtomicU32::new(u32::MAX),
                stalled: Notify::new(),
            });
            self.0
                .send(Dial {
                    peer,
                    at: Instant::now(),
                    closed,
                    target: target.clone(),
                    stderr: stderr.clone(),
                    writes: writes.clone(),
                })
                .unwrap();
            let (reader, writer) = tokio::io::split(client);
            Ok(DialedStream {
                reader: Box::pin(reader),
                writer: Box::pin(GateWriter(writer, writes)),
                stderr,
                close: Box::new(CloseSignal(close)),
            })
        })
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        RemoteError::Transport(failure.outcome.sentence().into())
    }
}

struct IngestGate {
    entered: oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

struct FakeMirror {
    tiers: &'static [Tier],
    recent_first: bool,
    cursors: Mutex<HashMap<Tier, Cursor>>,
    epoch: Mutex<Option<uuid::Uuid>>,
    recent: Mutex<Option<oneshot::Sender<Tier>>>,
    ingest_gate: Mutex<Option<IngestGate>>,
    cursor_unavailable: AtomicBool,
}

impl FakeMirror {
    fn new(tiers: &'static [Tier], recent_first: bool) -> Arc<Self> {
        Arc::new(Self {
            tiers,
            recent_first,
            cursors: Mutex::default(),
            epoch: Mutex::default(),
            recent: Mutex::default(),
            ingest_gate: Mutex::default(),
            cursor_unavailable: AtomicBool::new(false),
        })
    }

    fn block_next_ingest(&self) -> (oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (entered, entered_rx) = oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        *self.ingest_gate.lock_ok() = Some(IngestGate {
            entered,
            release: release_rx,
        });
        (entered_rx, release)
    }
}

impl MirrorSink for FakeMirror {
    fn cursor(
        &self,
        tier: Tier,
        epoch: uuid::Uuid,
        _: SyncKinds,
    ) -> std::result::Result<Option<Cursor>, MirrorError> {
        if self.cursor_unavailable.load(Ordering::Relaxed) {
            return Err(MirrorError::InvalidInput("test cursor unavailable"));
        }
        *self.epoch.lock_ok() = Some(epoch);
        Ok(self
            .cursors
            .lock_ok()
            .get(&tier)
            .copied()
            .filter(|cursor| cursor.epoch == epoch))
    }

    fn ingest(&self, page: SyncPage, _: SyncKinds) -> std::result::Result<(), MirrorError> {
        if let Some(gate) = self.ingest_gate.lock_ok().take() {
            gate.entered.send(()).unwrap();
            let _ = gate.release.recv();
        }
        self.cursors.lock_ok().insert(
            page.tier,
            Cursor {
                epoch: page.epoch,
                seq: page.last_seq,
            },
        );
        Ok(())
    }

    fn recent(
        &self,
        epoch: uuid::Uuid,
        tier: Tier,
        _: i64,
        _: Vec<WireLayout>,
        _: Vec<WireBucket>,
    ) -> std::result::Result<(), MirrorError> {
        if *self.epoch.lock_ok() != Some(epoch) {
            return Err(MirrorError::EpochChanged {
                operation: "recent-history",
            });
        }
        assert_eq!(tier, Tier::S10, "the host sends transient S10 snapshots");
        if let Some(recent) = self.recent.lock_ok().take() {
            recent.send(tier).unwrap();
        }
        Ok(())
    }

    fn sync_tiers(&self) -> &[Tier] {
        self.tiers
    }

    fn recent_first(&self) -> bool {
        self.recent_first
    }
}

struct Phone {
    source: Arc<RemoteSource>,
    dial: mpsc::UnboundedReceiver<Dial>,
    live: statglass_engine::LiveHub,
    status: watch::Receiver<ConnectionStatus>,
}

impl Phone {
    fn new(route: Route, mirror: Option<Arc<dyn MirrorSink>>, sync: SyncPolicy) -> Self {
        Self::with_routes(&[(route, "test-host")], mirror, sync)
    }

    fn with_routes(
        routes: &[(Route, &str)],
        mirror: Option<Arc<dyn MirrorSink>>,
        sync: SyncPolicy,
    ) -> Self {
        let (dial_tx, dial) = mpsc::unbounded_channel();
        let (status_tx, status) = watch::channel(ConnectionStatus::default());
        let source = RemoteSource::with_options(
            HostRecord::from_identity(fixture_hello().host, false),
            HostId(uuid::Uuid::nil()),
            Arc::new(PhoneDialer(dial_tx)),
            endpoint(routes),
            Arc::new(move |status| {
                status_tx.send_replace(status);
            }),
            mirror,
            SourceOptions {
                runtime: Some(tokio::runtime::Handle::current()),
                sync,
                probe: Some(Arc::new(|| BOTH_UP)),
            },
        );
        Self {
            source,
            dial,
            live: Default::default(),
            status,
        }
    }

    fn start(&self) -> SourceHandle {
        self.source
            .clone()
            .start(SourceSink {
                live: self.live.clone(),
                store: None,
            })
            .unwrap()
    }

    async fn connect(&mut self) -> Dial {
        let mut dial = self.next_dial().await;
        greet(&mut dial.peer).await;
        assert!(matches!(read(&mut dial.peer).await, Message::Interest(_)));
        let heartbeat = read(&mut dial.peer).await;
        pong(&mut dial.peer, heartbeat).await;
        dial
    }

    async fn next_dial(&mut self) -> Dial {
        timeout(WAIT, self.dial.recv()).await.unwrap().unwrap()
    }
}

async fn greet(peer: &mut DuplexStream) {
    send(peer, Message::Hello(Box::new(fixture_hello()))).await;
    assert!(matches!(read(peer).await, Message::HelloAck(_)));
}

async fn send(peer: &mut DuplexStream, message: Message) {
    codec::write(peer, &message).await.unwrap();
}

async fn read(peer: &mut DuplexStream) -> Message {
    timeout(WAIT, codec::read(peer)).await.unwrap().unwrap()
}

async fn pong(peer: &mut DuplexStream, ping: Message) {
    let Message::Ping { nonce, t0_ms } = ping else {
        panic!("expected Ping, received {ping:?}");
    };
    send(
        peer,
        Message::Pong {
            nonce,
            t0_ms,
            t_remote_ms: 9_000_000,
        },
    )
    .await;
}

async fn history_available(peer: &mut DuplexStream) {
    send(
        peer,
        Message::SourceStatus(SourceStatus {
            history_available: true,
            ..Default::default()
        }),
    )
    .await;
}

async fn recent_rows(peer: &mut DuplexStream) {
    send(
        peer,
        Message::RecentRows {
            epoch: fixture_hello().db_instance_uuid,
            tier: Tier::S10,
            complete_to_ms: 9_000_000,
            layouts: vec![],
            rows: vec![],
        },
    )
    .await;
}

async fn sync_request(peer: &mut DuplexStream, tier: Tier) -> SyncRequest {
    let Message::SyncRequest(request) = read(peer).await else {
        panic!("expected sync for {tier:?}");
    };
    assert_eq!(request.tier, tier);
    request
}

async fn sync_page(peer: &mut DuplexStream, tier: Tier, seq: i64, more: bool) {
    send(
        peer,
        Message::SyncPage(SyncPage {
            tier,
            epoch: fixture_hello().db_instance_uuid,
            last_seq: seq,
            more,
            layouts: vec![],
            rows: vec![],
            gaps: vec![],
            events: vec![],
        }),
    )
    .await;
}

async fn silence(peer: &mut DuplexStream) {
    assert!(
        timeout(WAIT, codec::read(peer)).await.is_err(),
        "unexpected wire traffic"
    );
}

async fn eof(peer: &mut DuplexStream) {
    assert!(matches!(
        timeout(WAIT, codec::read(peer)).await.unwrap(),
        Err(RemoteError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof
    ));
}

#[tokio::test(start_paused = true)]
async fn off_keeps_live_frames_and_policy_changes_take_effect_on_the_same_stream() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    let mut phone = Phone::new(Route::Lan, Some(mirror), SyncPolicy::Off);
    let mut events = phone.live.subscribe();
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    send(
        &mut dial.peer,
        Message::HostSummary(HostSummary {
            ts_ms: 42,
            online: true,
            headline: vec![],
        }),
    )
    .await;
    timeout(WAIT, async {
        while let Some(event) = events.recv().await {
            if let BusMsg::Frame(frame) = event {
                assert_eq!(frame.ts_ms, 42);
                return;
            }
        }
        panic!("source closed the live feed");
    })
    .await
    .unwrap();
    silence(&mut dial.peer).await;

    phone.source.set_sync_policy(SyncPolicy::Full);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(_)));
    sync_request(&mut dial.peer, Tier::M1).await;
    sync_page(&mut dial.peer, Tier::M1, 1, false).await;
    sync_request(&mut dial.peer, Tier::M15).await;
    phone.source.set_sync_policy(SyncPolicy::Off);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(_)));
    sync_page(&mut dial.peer, Tier::M15, 1, true).await;
    silence(&mut dial.peer).await;
    assert!(phone.dial.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn summary_only_requests_the_last_sink_tier() {
    let mut phone = Phone::new(
        Route::Lan,
        Some(FakeMirror::new(PHONE_TIERS, true)),
        SyncPolicy::SummaryOnly,
    );
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    sync_request(&mut dial.peer, Tier::M15).await;
    sync_page(&mut dial.peer, Tier::M15, 1, false).await;
    silence(&mut dial.peer).await;
}

#[tokio::test(start_paused = true)]
async fn an_empty_sink_tier_list_sends_no_sync_under_either_active_policy() {
    let mut phone = Phone::new(
        Route::Lan,
        Some(FakeMirror::new(&[], true)),
        SyncPolicy::SummaryOnly,
    );
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    silence(&mut dial.peer).await;
    phone.source.set_sync_policy(SyncPolicy::Full);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(_)));
    silence(&mut dial.peer).await;
}

#[tokio::test(start_paused = true)]
async fn phone_detail_requests_and_delivers_recent_rows_before_first_sync_page() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    let (tx, rx) = oneshot::channel();
    *mirror.recent.lock_ok() = Some(tx);
    let mut phone = Phone::new(Route::Lan, Some(mirror), SyncPolicy::Full);
    let handle = phone.start();
    let mut dial = phone.connect().await;
    handle.control().set_detail_interest(true);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if interest.detail));
    history_available(&mut dial.peer).await;
    assert!(
        matches!(read(&mut dial.peer).await, Message::RecentRequest { from_ms, to_ms } if to_ms - from_ms == 300_000)
    );
    silence(&mut dial.peer).await;
    recent_rows(&mut dial.peer).await;
    assert_eq!(timeout(WAIT, rx).await.unwrap().unwrap(), Tier::S10);
    sync_request(&mut dial.peer, Tier::M1).await;
}

#[tokio::test(start_paused = true)]
async fn opening_detail_during_catchup_gets_recent_rows_before_the_next_sync_page() {
    let mut phone = Phone::new(
        Route::Lan,
        Some(FakeMirror::new(PHONE_TIERS, true)),
        SyncPolicy::Full,
    );
    let handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    sync_request(&mut dial.peer, Tier::M1).await;
    handle.control().set_detail_interest(true);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if interest.detail));
    sync_page(&mut dial.peer, Tier::M1, 8, true).await;
    assert!(matches!(
        read(&mut dial.peer).await,
        Message::RecentRequest { .. }
    ));
    recent_rows(&mut dial.peer).await;
    assert_eq!(
        sync_request(&mut dial.peer, Tier::M1)
            .await
            .after
            .unwrap()
            .seq,
        8
    );
}

#[tokio::test(start_paused = true)]
async fn desktop_detail_still_syncs_all_tiers_before_requesting_recent_rows() {
    let mut phone = Phone::new(
        Route::Lan,
        Some(FakeMirror::new(DESKTOP_TIERS, false)),
        SyncPolicy::Full,
    );
    let handle = phone.start();
    let mut dial = phone.connect().await;
    handle.control().set_detail_interest(true);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if interest.detail));
    history_available(&mut dial.peer).await;
    for tier in DESKTOP_TIERS {
        sync_request(&mut dial.peer, *tier).await;
        sync_page(&mut dial.peer, *tier, 1, false).await;
    }
    assert!(matches!(
        read(&mut dial.peer).await,
        Message::RecentRequest { .. }
    ));
}

#[tokio::test(start_paused = true)]
async fn the_injected_current_thread_runtime_dials_on_paused_time_and_stop_closes() {
    let mut phone = Phone::new(Route::Lan, None, SyncPolicy::Off);
    let mut handle = phone.start();
    let now = Instant::now();
    let mut dial = phone.connect().await;
    assert_eq!(dial.at, now);
    assert_eq!(Instant::now(), now);
    handle.stop();
    eof(&mut dial.peer).await;
    timeout(
        WAIT,
        phone
            .status
            .wait_for(|status| !status.connected && !status.dialing),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(phone.dial.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn off_still_initializes_the_epoch_for_transient_recent_rows() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    let (tx, rx) = oneshot::channel();
    *mirror.recent.lock_ok() = Some(tx);
    let mut phone = Phone::new(Route::Lan, Some(mirror), SyncPolicy::Off);
    let handle = phone.start();
    handle.control().set_detail_interest(true);
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    assert!(matches!(
        read(&mut dial.peer).await,
        Message::RecentRequest { .. }
    ));
    recent_rows(&mut dial.peer).await;
    assert_eq!(timeout(WAIT, rx).await.unwrap().unwrap(), Tier::S10);
    silence(&mut dial.peer).await;
}

#[tokio::test(start_paused = true)]
async fn a_recovered_epoch_lookup_clears_the_recent_history_error_with_sync_off() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    mirror.cursor_unavailable.store(true, Ordering::Relaxed);
    let mut phone = Phone::new(Route::Lan, Some(mirror.clone()), SyncPolicy::Off);
    let handle = phone.start();
    handle.control().set_detail_interest(true);
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    {
        let status = timeout(
            WAIT,
            phone
                .status
                .wait_for(|status| status.history_error.is_some()),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(status.connected);
        assert!(
            status
                .history_error
                .as_deref()
                .unwrap()
                .contains("test cursor unavailable")
        );
    }
    handle.control().set_detail_interest(false);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if !interest.detail));
    mirror.cursor_unavailable.store(false, Ordering::Relaxed);
    handle.control().set_detail_interest(true);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if interest.detail));
    assert!(matches!(
        read(&mut dial.peer).await,
        Message::RecentRequest { .. }
    ));
    recent_rows(&mut dial.peer).await;
    let status = timeout(
        WAIT,
        phone
            .status
            .wait_for(|status| status.history_error.is_none()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(status.connected);
}

#[tokio::test(start_paused = true)]
async fn opening_detail_keeps_a_pending_summary_recent_reply_and_refreshes_detail_afterward() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    let (tx, rx) = oneshot::channel();
    *mirror.recent.lock_ok() = Some(tx);
    let mut phone = Phone::new(Route::Lan, Some(mirror), SyncPolicy::SummaryOnly);
    let handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    sync_request(&mut dial.peer, Tier::M15).await; // Initializes the epoch before summary demand.
    sync_page(&mut dial.peer, Tier::M15, 1, false).await;
    phone.source.set_recent_interest(true);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(_)));
    assert!(matches!(
        read(&mut dial.peer).await,
        Message::RecentRequest { .. }
    ));
    handle.control().set_detail_interest(true);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if interest.detail));
    advance(Duration::from_secs(2)).await;
    recent_rows(&mut dial.peer).await;
    assert_eq!(timeout(WAIT, rx).await.unwrap().unwrap(), Tier::S10);
    assert!(matches!(
        read(&mut dial.peer).await,
        Message::RecentRequest { .. }
    ));
}

#[tokio::test(start_paused = true)]
async fn quiesce_waits_for_the_commit_then_closes_and_resumes_from_its_cursor() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::new(Route::Lan, Some(mirror.clone()), SyncPolicy::Full);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    sync_request(&mut dial.peer, Tier::M1).await;
    sync_page(&mut dial.peer, Tier::M1, 7, true).await;
    timeout(WAIT, entered).await.unwrap().unwrap();
    let mut quiesced = phone.source.quiesce();
    tokio::select! {
        biased;
        () = &mut quiesced => panic!("quiesce completed before commit"),
        () = advance(Duration::from_secs(1)) => {}
    }
    assert_eq!(
        dial.closed.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    );
    assert!(mirror.cursors.lock_ok().is_empty());
    release.send(()).unwrap();
    timeout(WAIT, quiesced).await.unwrap();
    dial.closed.await.unwrap();
    eof(&mut dial.peer).await;
    let committed = Cursor {
        epoch: fixture_hello().db_instance_uuid,
        seq: 7,
    };
    assert_eq!(mirror.cursors.lock_ok().get(&Tier::M1), Some(&committed));
    assert!(
        timeout(Duration::from_secs(65), phone.dial.recv())
            .await
            .is_err()
    );
    phone.source.resume();
    let mut next = phone.connect().await;
    history_available(&mut next.peer).await;
    assert_eq!(
        sync_request(&mut next.peer, Tier::M1).await.after,
        Some(committed)
    );
    assert!(phone.dial.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn idle_quiesce_closes_within_five_seconds_and_resume_resets_backoff() {
    let mut phone = Phone::new(Route::Lan, None, SyncPolicy::Off);
    let _handle = phone.start();
    // Fail two handshakes so the source has a backoff to reset.
    for _ in 0..2 {
        let attempt = timeout(WAIT, phone.dial.recv()).await.unwrap().unwrap();
        drop(attempt.peer);
    }
    let mut dial = phone.connect().await;
    timeout(Duration::from_secs(5), phone.source.quiesce())
        .await
        .unwrap();
    dial.closed.await.unwrap();
    eof(&mut dial.peer).await;
    assert!(
        timeout(Duration::from_secs(65), phone.dial.recv())
            .await
            .is_err()
    );
    let resumed = Instant::now();
    phone.source.resume();
    let attempt = timeout(WAIT, phone.dial.recv()).await.unwrap().unwrap();
    assert_eq!(attempt.at, resumed);
    assert!(phone.dial.try_recv().is_err());
    drop(attempt.peer);
    let retry = timeout(Duration::from_millis(1250), phone.dial.recv())
        .await
        .unwrap()
        .unwrap();
    assert!((Duration::from_secs(1)..Duration::from_millis(1250)).contains(&(retry.at - resumed)));
    assert_eq!(phone.status.borrow().attempt, 1);
}

#[tokio::test(start_paused = true)]
async fn absent_route_classes_drop_and_redial_without_waiting_for_a_ping() {
    for (route, net) in [
        (
            Route::Tailscale,
            LocalNetwork {
                tailscale_up: false,
                ..BOTH_UP
            },
        ),
        (
            Route::Lan,
            LocalNetwork {
                lan_up: false,
                ..BOTH_UP
            },
        ),
    ] {
        let mut phone = Phone::new(route, None, SyncPolicy::Off);
        let _handle = phone.start();
        let mut dial = phone.connect().await;
        let changed = Instant::now();
        phone.source.network_changed_with(net);
        eof(&mut dial.peer).await;
        let redial = timeout(WAIT, phone.dial.recv()).await.unwrap().unwrap();
        assert_eq!(redial.at, changed);
    }
}

#[tokio::test(start_paused = true)]
async fn route_loss_closes_during_ingest_and_the_redial_uses_the_committed_cursor() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::new(Route::Lan, Some(mirror), SyncPolicy::Full);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    sync_request(&mut dial.peer, Tier::M1).await;
    sync_page(&mut dial.peer, Tier::M1, 7, true).await;
    timeout(WAIT, entered).await.unwrap().unwrap();

    phone.source.network_changed_with(LocalNetwork {
        lan_up: false,
        ..BOTH_UP
    });
    // Explicitly move the clock while the blocking pool contains pending work.
    let closed = tokio::select! {
        biased;
        message = codec::read(&mut dial.peer) => Some(message),
        () = advance(Duration::from_secs(1)) => None,
    };
    assert!(
        matches!(closed, Some(Err(RemoteError::Io(error))) if error.kind() == std::io::ErrorKind::UnexpectedEof)
    );
    release.send(()).unwrap();
    let mut next = phone.connect().await;
    history_available(&mut next.peer).await;
    assert_eq!(
        sync_request(&mut next.peer, Tier::M1)
            .await
            .after
            .unwrap()
            .seq,
        7
    );
}

#[tokio::test(start_paused = true)]
async fn known_available_route_gets_an_immediate_ping_and_drops_after_five_seconds_without_pong() {
    let mut phone = Phone::new(Route::Lan, None, SyncPolicy::Off);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    let changed = Instant::now();
    phone.source.network_changed_with(BOTH_UP);
    assert!(matches!(read(&mut dial.peer).await, Message::Ping { .. }));
    assert_eq!(Instant::now(), changed);
    silence(&mut dial.peer).await;
    eof(&mut dial.peer).await;
    let redial = timeout(WAIT, phone.dial.recv()).await.unwrap().unwrap();
    assert_eq!(redial.at - changed, NETWORK_CHANGE_PROBE);
}

#[tokio::test(start_paused = true)]
async fn a_blocked_ingest_does_not_delay_a_path_ping_or_its_deadline() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::new(Route::Lan, Some(mirror), SyncPolicy::Full);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    sync_request(&mut dial.peer, Tier::M1).await;
    sync_page(&mut dial.peer, Tier::M1, 7, true).await;
    timeout(WAIT, entered).await.unwrap().unwrap();

    let changed = Instant::now();
    phone.source.network_changed_with(BOTH_UP);
    let ping = tokio::select! {
        biased;
        message = codec::read(&mut dial.peer) => message.unwrap(),
        () = async {
            for _ in 0..10 { tokio::task::yield_now().await; }
        } => panic!("path Ping waited for the mirror write"),
    };
    assert!(matches!(ping, Message::Ping { .. }));
    assert_eq!(Instant::now(), changed);
    advance(NETWORK_CHANGE_PROBE - changed.elapsed()).await;
    let closed = tokio::select! {
        biased;
        message = codec::read(&mut dial.peer) => Some(message),
        () = async {
            for _ in 0..10 { advance(Duration::from_millis(1)).await; }
        } => None,
    };
    assert!(
        matches!(closed, Some(Err(RemoteError::Io(error))) if error.kind() == std::io::ErrorKind::UnexpectedEof)
    );
    release.send(()).unwrap();
    let mut redial = phone.connect().await;
    history_available(&mut redial.peer).await;
    assert_eq!(
        sync_request(&mut redial.peer, Tier::M1)
            .await
            .after
            .unwrap()
            .seq,
        7
    );
}

#[tokio::test(start_paused = true)]
async fn interest_waits_while_the_path_probe_can_time_out() {
    let mut phone = Phone::new(Route::Lan, None, SyncPolicy::Off);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    dial.writes.remaining.store(1, Ordering::Relaxed);
    let changed = Instant::now();
    phone.source.network_changed_with(BOTH_UP);
    assert!(matches!(read(&mut dial.peer).await, Message::Ping { .. }));
    assert!(timeout(WAIT, dial.writes.stalled.notified()).await.is_err());
    advance(NETWORK_CHANGE_PROBE - changed.elapsed()).await;
    eof(&mut dial.peer).await;
    assert_eq!(phone.next_dial().await.at - changed, NETWORK_CHANGE_PROBE);
}

#[tokio::test(start_paused = true)]
async fn a_valid_path_pong_keeps_the_session_when_the_following_write_stalls() {
    let mut phone = Phone::new(Route::Lan, None, SyncPolicy::Off);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    dial.writes.remaining.store(1, Ordering::Relaxed);
    phone.source.network_changed_with(BOTH_UP);
    let ping = read(&mut dial.peer).await;
    pong(&mut dial.peer, ping).await;
    timeout(WAIT, dial.writes.stalled.notified()).await.unwrap();
    advance(NETWORK_CHANGE_PROBE).await;
    assert!(
        timeout(Duration::from_secs(1), phone.dial.recv())
            .await
            .is_err(),
        "a matching Pong kept this path alive"
    );
}

#[tokio::test(start_paused = true)]
async fn a_network_change_discards_a_stream_with_an_already_stalled_write() {
    let mut phone = Phone::new(Route::Lan, None, SyncPolicy::Off);
    let handle = phone.start();
    let mut dial = phone.connect().await;
    dial.writes.remaining.store(0, Ordering::Relaxed);
    handle.control().set_detail_interest(true);
    timeout(WAIT, dial.writes.stalled.notified()).await.unwrap();
    let changed = Instant::now();
    phone.source.network_changed_with(BOTH_UP);
    eof(&mut dial.peer).await;
    assert_eq!(phone.next_dial().await.at, changed);
}

#[tokio::test(start_paused = true)]
async fn a_network_change_while_draining_rejects_the_older_promotion() {
    let mirror = FakeMirror::new(PHONE_TIERS, true);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::with_routes(
        &[
            (Route::Lan, "studio.local"),
            (Route::Tailscale, "studio.tail"),
        ],
        Some(mirror),
        SyncPolicy::Full,
    );
    let _handle = phone.start();
    let lan = phone.next_dial().await;
    assert_eq!(lan.target.route, Route::Lan);
    drop(lan.peer);
    let mut active = phone.connect().await;
    assert_eq!(active.target.route, Route::Tailscale);
    history_available(&mut active.peer).await;
    sync_request(&mut active.peer, Tier::M1).await;
    sync_page(&mut active.peer, Tier::M1, 7, true).await;
    timeout(WAIT, entered).await.unwrap().unwrap();

    phone.source.network_changed_with(BOTH_UP);
    let ping = read(&mut active.peer).await;
    pong(&mut active.peer, ping).await;
    assert!(matches!(read(&mut active.peer).await, Message::Interest(_)));
    tokio::task::yield_now().await;
    advance(crate::PROMOTION_DEBOUNCE + Duration::from_millis(1)).await;
    let mut candidate = phone.next_dial().await;
    assert_eq!(candidate.target.route, Route::Lan);
    greet(&mut candidate.peer).await;
    eof(&mut active.peer).await;

    phone.source.network_changed_with(LocalNetwork {
        lan_up: false,
        ..BOTH_UP
    });
    release.send(()).unwrap();
    eof(&mut candidate.peer).await;
    assert_eq!(phone.next_dial().await.target.route, Route::Lan);
    assert_eq!(phone.next_dial().await.target.route, Route::Tailscale);
}

#[tokio::test(start_paused = true)]
async fn a_marker_winning_the_race_still_publishes_both_route_causes() {
    let mut phone = Phone::with_routes(
        &[
            (Route::Lan, "studio.local"),
            (Route::Tailscale, "studio.tail"),
        ],
        None,
        SyncPolicy::Off,
    );
    let _handle = phone.start();
    let lan = phone.next_dial().await;
    assert_eq!(lan.target.route, Route::Lan);
    lan.stderr.push(APP_NOT_RUNNING.as_bytes());
    drop(lan.peer);
    let tailnet = phone.next_dial().await;
    assert_eq!(tailnet.target.route, Route::Tailscale);
    tailnet.stderr.push(MONITORING_OFF.as_bytes());
    drop(tailnet.peer);
    let failure = timeout(
        WAIT,
        phone
            .status
            .wait_for(|status| status.failure_kind == Some(ConnectionFailureKind::MonitoringOff)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        failure.route_failures,
        [
            RouteFailure {
                route: Route::Lan,
                kind: ConnectionFailureKind::AppNotRunning
            },
            RouteFailure {
                route: Route::Tailscale,
                kind: ConnectionFailureKind::MonitoringOff
            },
        ]
    );
    assert_eq!(
        failure.error.as_deref(),
        Some(
            "LAN: StatGlass isn't running on studio.local; Tailscale: Remote monitoring is off on studio.tail"
        )
    );
}

#[tokio::test(start_paused = true)]
async fn a_pong_from_a_previous_path_does_not_keep_the_latest_path_alive() {
    let mut phone = Phone::new(Route::Lan, None, SyncPolicy::Off);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    phone.source.network_changed_with(BOTH_UP);
    let old = read(&mut dial.peer).await;
    advance(Duration::from_secs(1)).await;
    let changed = Instant::now();
    phone.source.network_changed_with(BOTH_UP);
    let new = read(&mut dial.peer).await;
    assert!(matches!(new, Message::Ping { .. }));
    assert_ne!(old, new);
    pong(&mut dial.peer, old).await;
    advance(NETWORK_CHANGE_PROBE).await;
    eof(&mut dial.peer).await;
    let redial = timeout(WAIT, phone.dial.recv()).await.unwrap().unwrap();
    assert_eq!(redial.at - changed, NETWORK_CHANGE_PROBE);
}

#[tokio::test(start_paused = true)]
async fn unknown_network_leaves_the_stream_running_without_a_path_probe() {
    let mut phone = Phone::new(Route::Lan, None, SyncPolicy::Off);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    phone.source.report_network_change(UNKNOWN_NETWORK);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(_)));
    advance(NETWORK_CHANGE_PROBE + Duration::from_secs(1)).await;
    silence(&mut dial.peer).await;
    assert!(phone.dial.try_recv().is_err());
    assert!(phone.status.borrow().connected);
}
