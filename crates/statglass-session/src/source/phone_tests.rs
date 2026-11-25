use super::*;
use crate::{
    APP_NOT_RUNNING, BoxFuture, Close, DialFailure, DialedStream, MONITORING_OFF, MirrorError,
    StderrTail, Target,
    network::{LocalNetwork, UNKNOWN_NETWORK},
    test_support::{endpoint, fixture_hello},
};
use statglass_proto::{SourceStatus, SyncPage, SyncRequest};
use std::{
    io,
    pin::Pin,
    sync::atomic::AtomicUsize,
    task::{Context, Poll, Waker},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf, ReadHalf, WriteHalf},
    sync::{Notify, mpsc, oneshot},
    time::{advance, timeout},
};

const WAIT: Duration = Duration::from_secs(3);
const MINUTE_TIERS: &[Tier] = &[Tier::M1, Tier::M15];
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
    panic_on_read: Arc<AtomicBool>,
}

struct GateReader(ReadHalf<DuplexStream>, Arc<AtomicBool>);

impl AsyncRead for GateReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        assert!(!self.1.load(Ordering::Relaxed), "scripted read panic");
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

struct WriteGate {
    panic_on_write: AtomicBool,
    remaining: AtomicU32,
    stalled: Notify,
    flush: Mutex<FlushGate>,
}

#[derive(Default)]
struct FlushGate {
    blocked: bool,
    waker: Option<Waker>,
}

impl WriteGate {
    fn release_flush(&self) {
        let mut flush = self.flush.lock_ok();
        flush.blocked = false;
        if let Some(waker) = flush.waker.take() {
            waker.wake();
        }
    }
}

struct GateWriter(WriteHalf<DuplexStream>, Arc<WriteGate>);

impl AsyncWrite for GateWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        assert!(
            !self.1.panic_on_write.load(Ordering::Relaxed),
            "scripted write panic"
        );
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
        {
            let mut flush = self.1.flush.lock_ok();
            if flush.blocked {
                flush.waker = Some(cx.waker().clone());
                self.1.stalled.notify_one();
                return Poll::Pending;
            }
        }
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
            let panic_on_read = Arc::new(AtomicBool::new(false));
            let writes = Arc::new(WriteGate {
                panic_on_write: AtomicBool::new(false),
                remaining: AtomicU32::new(u32::MAX),
                stalled: Notify::new(),
                flush: Mutex::default(),
            });
            self.0
                .send(Dial {
                    peer,
                    at: Instant::now(),
                    closed,
                    target: target.clone(),
                    stderr: stderr.clone(),
                    writes: writes.clone(),
                    panic_on_read: panic_on_read.clone(),
                })
                .unwrap();
            let (reader, writer) = tokio::io::split(client);
            Ok(DialedStream {
                reader: Box::pin(GateReader(reader, panic_on_read)),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MirrorCall {
    Cursor,
    Floor,
    Truncated,
}

struct MirrorObserver {
    runtime: std::thread::ThreadId,
    calls: mpsc::UnboundedSender<(MirrorCall, bool)>,
}

struct FakeMirror {
    tiers: &'static [Tier],
    cursors: Mutex<HashMap<Tier, Cursor>>,
    ingest_gate: Mutex<Option<IngestGate>>,
    panic_on_ingest: AtomicBool,
    observer: Option<MirrorObserver>,
}

impl FakeMirror {
    fn new(tiers: &'static [Tier]) -> Arc<Self> {
        Arc::new(Self {
            tiers,
            cursors: Mutex::default(),
            ingest_gate: Mutex::default(),
            panic_on_ingest: AtomicBool::new(false),
            observer: None,
        })
    }

    fn observed(mirror: &mut Arc<Self>) -> mpsc::UnboundedReceiver<(MirrorCall, bool)> {
        let (calls, received) = mpsc::unbounded_channel();
        Arc::get_mut(mirror).unwrap().observer = Some(MirrorObserver {
            runtime: std::thread::current().id(),
            calls,
        });
        received
    }

    fn record_call(&self, call: MirrorCall) {
        if let Some(observer) = &self.observer {
            let off_runtime = std::thread::current().id() != observer.runtime;
            observer.calls.send((call, off_runtime)).unwrap();
        }
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
        self.record_call(MirrorCall::Cursor);
        Ok(self
            .cursors
            .lock_ok()
            .get(&tier)
            .copied()
            .filter(|cursor| cursor.epoch == epoch))
    }

    fn ingest(&self, page: SyncPage, _: SyncKinds) -> std::result::Result<(), MirrorError> {
        assert!(
            !self.panic_on_ingest.load(Ordering::Relaxed),
            "scripted mirror write panic"
        );
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

    fn sync_tiers(&self) -> &[Tier] {
        self.tiers
    }

    fn history_floor(&self, _: Tier, now: i64) -> i64 {
        self.record_call(MirrorCall::Floor);
        now - 60_000
    }

    fn truncated(&self, _: Tier, _: uuid::Uuid, _: i64) -> std::result::Result<(), MirrorError> {
        self.record_call(MirrorCall::Truncated);
        Ok(())
    }
}

struct Phone {
    source: Arc<RemoteSource>,
    dial: mpsc::UnboundedReceiver<Dial>,
    live: statglass_engine::LiveHub,
    status: watch::Receiver<ConnectionStatus>,
    published: Arc<Mutex<Vec<ConnectionStatus>>>,
}

impl Phone {
    fn new(route: Route, mirror: Option<Arc<dyn MirrorSink>>) -> Self {
        Self::with_routes(&[(route, "test-host")], mirror)
    }

    fn with_routes(routes: &[(Route, &str)], mirror: Option<Arc<dyn MirrorSink>>) -> Self {
        let (dial_tx, dial) = mpsc::unbounded_channel();
        let (status_tx, status) = watch::channel(ConnectionStatus::default());
        let published = Arc::new(Mutex::new(Vec::new()));
        let source = RemoteSource::with_options(
            HostRecord::from_identity(fixture_hello().host, false),
            HostId(uuid::Uuid::nil()),
            Arc::new(PhoneDialer(dial_tx)),
            endpoint(routes),
            Arc::new({
                let published = published.clone();
                move |status| {
                    published.lock_ok().push(status.clone());
                    status_tx.send_replace(status);
                }
            }),
            mirror,
            SourceOptions {
                runtime: Some(tokio::runtime::Handle::current()),
                probe: Some(Arc::new(|| BOTH_UP)),
            },
        );
        Self {
            source,
            dial,
            live: Default::default(),
            status,
            published,
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
async fn an_empty_sink_tier_list_sends_no_sync() {
    let mut phone = Phone::new(Route::Lan, Some(FakeMirror::new(&[])));
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    silence(&mut dial.peer).await;
}

#[tokio::test(start_paused = true)]
async fn desktop_detail_still_syncs_all_tiers_before_requesting_recent_rows() {
    let mut phone = Phone::new(Route::Lan, Some(FakeMirror::new(DESKTOP_TIERS)));
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
async fn a_refill_is_promised_before_live_detail_reaches_the_session() {
    // A screen subscribes a frame before its demand turns live detail on, so the
    // promise cannot wait for detail; a window that never gets the refill stops
    // waiting on its own (`REFILL_WAIT_MS`).
    let mut phone = Phone::new(Route::Lan, None);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(phone.live.refill_pending());
}

/// The phone keeps no mirror (D-154), so live detail asks the host for its recent rows
/// once and the ring shows the minutes before the connection, not only frames since.
#[tokio::test(start_paused = true)]
async fn phone_detail_refills_the_ring_from_recent_rows_once() {
    use statglass_proto::{WireBucket, WireLayout};
    use statglass_schema::{MetricId, SeriesKey};
    let mut phone = Phone::new(Route::Lan, None);
    let handle = phone.start();
    let mut dial = phone.connect().await;
    handle.control().set_detail_interest(true);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if interest.detail));
    history_available(&mut dial.peer).await;
    let Message::RecentRequest { from_ms, to_ms } = read(&mut dial.peer).await else {
        panic!("expected a recent-rows request, not a sync");
    };
    assert_eq!(to_ms - from_ms, 300_000, "five minutes of recent rows");
    assert!(
        phone.live.refill_pending(),
        "open windows wait for the refill"
    );
    let complete_to_ms = to_ms - to_ms.rem_euclid(10_000);
    let buckets: Vec<i64> = (1..=6).rev().map(|i| complete_to_ms - i * 10_000).collect();
    send(
        &mut dial.peer,
        Message::RecentRows {
            epoch: fixture_hello().db_instance_uuid,
            tier: Tier::S10,
            complete_to_ms,
            layouts: vec![WireLayout {
                layout_no: 1,
                series: vec![SeriesKey::bare(MetricId::from_static("cpu.total"))],
            }],
            rows: buckets
                .iter()
                .zip(1_i16..)
                .map(|(&bucket_ts, n)| WireBucket {
                    seq: 0,
                    bucket_ts,
                    layout_no: 1,
                    stats: vec![f32::from(n); 3],
                })
                .collect(),
        },
    )
    .await;
    let mut filled = Vec::new();
    for _ in 0..30 {
        filled = phone.live.backfill(i64::MIN);
        if !filled.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let values: Vec<f32> = filled
        .iter()
        .flat_map(|s| s.rows.iter().map(|r| r[0]))
        .collect();
    assert_eq!(
        values,
        [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        "one ring row per bucket"
    );
    assert!(!phone.live.refill_pending(), "the refill ends the wait");

    // Detail stays on: the ring is filled, so the phone answers pings and asks for nothing.
    for _ in 0..4 {
        advance(Duration::from_secs(30)).await;
        while let Ok(Ok(message)) =
            timeout(Duration::from_secs(1), codec::read(&mut dial.peer)).await
        {
            assert!(
                !matches!(
                    message,
                    Message::RecentRequest { .. } | Message::SyncRequest(_)
                ),
                "asked again: {message:?}"
            );
            if matches!(message, Message::Ping { .. }) {
                pong(&mut dial.peer, message).await;
            }
        }
    }
}

#[tokio::test(start_paused = true)]
async fn the_injected_current_thread_runtime_dials_on_paused_time_and_stop_closes() {
    let mut phone = Phone::new(Route::Lan, None);
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
async fn resume_without_quiesce_keeps_the_live_session() {
    let mut phone = Phone::new(Route::Lan, None);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    phone.source.resume();
    silence(&mut dial.peer).await;
    assert!(phone.status.borrow().connected);
    assert!(phone.dial.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn a_panicking_writer_publishes_one_internal_failure_and_can_retry() {
    assert_live_panic_recovery(false).await;
}

#[tokio::test(start_paused = true)]
async fn a_panicking_reader_publishes_one_internal_failure_and_can_retry() {
    assert_live_panic_recovery(true).await;
}

#[tokio::test(start_paused = true)]
async fn a_panicking_mirror_write_publishes_one_internal_failure() {
    let (logged, _subscriber) = capture_panic_logs();
    let mirror = FakeMirror::new(MINUTE_TIERS);
    mirror.panic_on_ingest.store(true, Ordering::Relaxed);
    let mut phone = Phone::new(Route::Lan, Some(mirror));
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    sync_request(&mut dial.peer, Tier::M1).await;
    sync_page(&mut dial.peer, Tier::M1, 7, true).await;

    let status = timeout(WAIT, phone.status.wait_for(|status| !status.connected))
        .await
        .unwrap()
        .unwrap()
        .clone();
    assert_eq!(status.failure_kind, Some(ConnectionFailureKind::Internal));
    assert!(!status.retrying && !status.dialing);
    assert_eq!(status.next_attempt_ms, None);
    eof(&mut dial.peer).await;
    assert!(timeout(WAIT, phone.dial.recv()).await.is_err());
    assert_eq!(
        phone
            .published
            .lock_ok()
            .iter()
            .filter(|status| { status.failure_kind == Some(ConnectionFailureKind::Internal) })
            .count(),
        1
    );
    assert_eq!(logged.load(Ordering::Relaxed), 1);
}

#[tokio::test(start_paused = true)]
async fn quiesce_after_a_panic_acknowledges_and_resume_reconnects() {
    let (_logged, _subscriber) = capture_panic_logs();
    let mut phone = Phone::new(Route::Lan, None);
    let handle = phone.start();
    let mut dial = phone.connect().await;
    dial.writes.panic_on_write.store(true, Ordering::Relaxed);
    handle.control().set_detail_interest(true);
    timeout(
        WAIT,
        phone
            .status
            .wait_for(|status| status.failure_kind == Some(ConnectionFailureKind::Internal)),
    )
    .await
    .unwrap()
    .unwrap();

    timeout(WAIT, phone.source.quiesce())
        .await
        .expect("the panicked source should acknowledge quiesce");
    eof(&mut dial.peer).await;
    assert!(phone.dial.try_recv().is_err());
    phone.source.resume();
    let _next_dial = phone.connect().await;
    assert!(phone.status.borrow().connected);
    assert_eq!(phone.status.borrow().failure_kind, None);
}

#[tokio::test(start_paused = true)]
async fn retry_after_a_writer_panic_waits_for_the_mirror_write_to_finish() {
    let (_logged, _subscriber) = capture_panic_logs();
    let mirror = FakeMirror::new(MINUTE_TIERS);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::new(Route::Lan, Some(mirror));
    let handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    sync_request(&mut dial.peer, Tier::M1).await;
    sync_page(&mut dial.peer, Tier::M1, 7, true).await;
    timeout(WAIT, entered).await.unwrap().unwrap();

    dial.writes.panic_on_write.store(true, Ordering::Relaxed);
    handle.control().set_detail_interest(true);
    eof(&mut dial.peer).await;

    let source = phone.source.clone();
    let mut status = phone.status.clone();
    let mut retry = std::pin::pin!(async move {
        status
            .wait_for(|status| status.failure_kind == Some(ConnectionFailureKind::Internal))
            .await
            .unwrap();
        source.retry();
    });
    tokio::select! {
        biased;
        () = &mut retry => {
            let _early_dial = phone.next_dial().await;
            panic!("a second session dialed while the mirror write was still blocked");
        }
        () = advance(Duration::from_secs(1)) => {}
    }

    release.send(()).unwrap();
    timeout(WAIT, retry).await.unwrap();
    let mut next = phone.connect().await;
    history_available(&mut next.peer).await;
    let cursor = sync_request(&mut next.peer, Tier::M1).await.after.unwrap();
    assert_eq!(cursor.seq, 7);
}

fn capture_panic_logs() -> (Arc<AtomicUsize>, tracing::subscriber::DefaultGuard) {
    use tracing::{Event, Level, Metadata, Subscriber, span, subscriber::Interest};

    struct ErrorCount(Arc<AtomicUsize>);

    impl Subscriber for ErrorCount {
        fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
            Interest::sometimes()
        }
        fn enabled(&self, metadata: &Metadata<'_>) -> bool {
            *metadata.level() == Level::ERROR
        }
        fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
            span::Id::from_u64(1)
        }
        fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
        fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
        fn event(&self, _: &Event<'_>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
        fn enter(&self, _: &span::Id) {}
        fn exit(&self, _: &span::Id) {}
    }

    let logged = Arc::new(AtomicUsize::new(0));
    let subscriber = tracing::subscriber::set_default(ErrorCount(logged.clone()));
    (logged, subscriber)
}

async fn assert_live_panic_recovery(panic_on_read: bool) {
    let (logged, _subscriber) = capture_panic_logs();
    let mut phone = Phone::new(Route::Lan, None);
    let handle = phone.start();
    let mut dial = phone.connect().await;
    assert!(phone.status.borrow().connected);
    if panic_on_read {
        dial.panic_on_read.store(true, Ordering::Relaxed);
        dial.peer.write_u8(0).await.unwrap();
    } else {
        dial.writes.panic_on_write.store(true, Ordering::Relaxed);
        handle.control().set_detail_interest(true);
    }

    let status = timeout(WAIT, phone.status.wait_for(|status| !status.connected))
        .await
        .expect("the live status should change after the panic")
        .unwrap()
        .clone();
    assert_eq!(status.failure_kind, Some(ConnectionFailureKind::Internal));
    assert!(status.error.is_some());
    assert!(!status.retrying && !status.dialing);
    assert_eq!(status.next_attempt_ms, None);
    eof(&mut dial.peer).await;
    assert!(timeout(WAIT, phone.dial.recv()).await.is_err());
    phone.source.retry();
    let _next_dial = phone.connect().await;
    assert!(phone.status.borrow().connected);
    assert_eq!(phone.status.borrow().failure_kind, None);
    assert_eq!(
        phone
            .published
            .lock_ok()
            .iter()
            .filter(|status| {
                status.failure_kind == Some(ConnectionFailureKind::Internal)
                    && !status.connected
                    && !status.retrying
            })
            .count(),
        1
    );
    assert_eq!(logged.load(Ordering::Relaxed), 1);
}

#[tokio::test(start_paused = true)]
async fn an_unknown_query_reply_tells_the_client_to_update_statglass() {
    let answer = answer_space_volumes(statglass_proto::Answer::Unknown).await;
    assert!(matches!(answer, Err(RemoteError::Unsupported(message)) if
        message == "This host sent an answer this version can't read. Update StatGlass on this device."
    ));
}

#[tokio::test(start_paused = true)]
async fn a_host_worker_failure_is_distinct_from_a_query_refusal() {
    use statglass_proto::{Answer, ErrorCode};
    let failed = answer_space_volumes(Answer::Error {
        code: ErrorCode::Internal,
        message: "host query worker failed".into(),
    })
    .await;
    assert!(
        matches!(failed, Err(RemoteError::Internal(message)) if message == "host query worker failed")
    );
    let refused = answer_space_volumes(Answer::Error {
        code: ErrorCode::Unknown,
        message: "the host did not allow that query".into(),
    })
    .await;
    assert!(
        matches!(refused, Err(RemoteError::Refused(message)) if message == "the host did not allow that query")
    );
}

async fn answer_space_volumes(
    reply: statglass_proto::Answer,
) -> Result<Vec<statglass_schema::disk_space::SpaceVolume>> {
    use statglass_proto::Query;

    let mut phone = Phone::new(Route::Lan, None);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    let (answer, ()) = tokio::join!(phone.source.space_volumes(), async {
        let Message::Request {
            id,
            query: Query::SpaceVolumes,
        } = read(&mut dial.peer).await
        else {
            panic!("expected a disk volumes query");
        };
        send(&mut dial.peer, Message::Reply { id, answer: reply }).await;
    });
    answer
}

#[tokio::test(start_paused = true)]
async fn a_source_publishes_and_clears_both_incompatible_directions() {
    let old = statglass_proto::MIN_COMPATIBLE - 1;
    let new = statglass_proto::PROTO_VERSION + 1;
    for (version, side) in [(old, IncompatibleSide::Host), (new, IncompatibleSide::App)] {
        let mut phone = Phone::new(Route::Lan, None);
        let _handle = phone.start();
        let mut dial = phone.next_dial().await;
        let mut hello = fixture_hello();
        hello.min_compatible = version;
        hello.proto_version = version;
        send(&mut dial.peer, Message::Hello(Box::new(hello))).await;
        let incompatible = timeout(WAIT, phone.status.wait_for(|status| status.incompatible))
            .await
            .unwrap()
            .unwrap()
            .clone();
        assert_eq!(
            incompatible.failure_kind,
            Some(ConnectionFailureKind::Incompatible)
        );
        assert_eq!(incompatible.incompatible_side, Some(side));
        assert!(!incompatible.connected && !incompatible.retrying);
        phone.source.retry();
        let _next_dial = phone.connect().await;
        let status = phone.status.borrow();
        assert!(status.connected);
        assert_eq!(status.incompatible_side, None);
        assert_eq!(status.failure_kind, None);
    }
}

#[tokio::test(start_paused = true)]
async fn retry_during_a_dial_does_not_replace_the_successful_session() {
    let mut phone = Phone::new(Route::Lan, None);
    let _handle = phone.start();
    let mut dial = phone.next_dial().await;
    phone.source.retry();
    greet(&mut dial.peer).await;
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(_)));
    let ping = read(&mut dial.peer).await;
    pong(&mut dial.peer, ping).await;
    silence(&mut dial.peer).await;
    assert!(phone.dial.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn sync_cursor_floor_and_truncation_run_off_the_shared_runtime() {
    let mut mirror = FakeMirror::new(MINUTE_TIERS);
    let mut calls = FakeMirror::observed(&mut mirror);
    let mut phone = Phone::new(Route::Lan, Some(mirror));
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    history_available(&mut dial.peer).await;
    let first = sync_request(&mut dial.peer, Tier::M1).await;
    let floor = first.from_ms.unwrap() + 1_000_000;
    send(
        &mut dial.peer,
        Message::Truncated {
            tier: Tier::M1,
            earliest_ts_ms: floor,
            epoch: fixture_hello().db_instance_uuid,
        },
    )
    .await;
    let restarted = sync_request(&mut dial.peer, Tier::M1).await;
    assert_eq!(restarted.after, None);
    assert_eq!(restarted.from_ms, Some(floor));
    let mut observed = Vec::new();
    for _ in 0..4 {
        observed.push(timeout(WAIT, calls.recv()).await.unwrap().unwrap());
    }
    assert_eq!(
        observed,
        [
            (MirrorCall::Cursor, true),
            (MirrorCall::Floor, true),
            (MirrorCall::Truncated, true),
            (MirrorCall::Floor, true),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn quiesce_waits_for_the_commit_then_closes_and_resumes_from_its_cursor() {
    let mirror = FakeMirror::new(MINUTE_TIERS);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::new(Route::Lan, Some(mirror.clone()));
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
    let mut phone = Phone::new(Route::Lan, None);
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
        let mut phone = Phone::new(route, None);
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
    let mirror = FakeMirror::new(MINUTE_TIERS);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::new(Route::Lan, Some(mirror));
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
    let mut phone = Phone::new(Route::Lan, None);
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
async fn repeated_path_notifications_do_not_extend_the_first_probe_deadline() {
    let mut phone = Phone::new(Route::Lan, None);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    let first_change = Instant::now();
    for notification in 0..3 {
        if notification != 0 {
            advance(Duration::from_secs(2)).await;
        }
        phone.source.network_changed_with(BOTH_UP);
        assert!(matches!(read(&mut dial.peer).await, Message::Ping { .. }));
    }
    eof(&mut dial.peer).await;
    assert_eq!(
        phone.next_dial().await.at - first_change,
        NETWORK_CHANGE_PROBE
    );
}

#[tokio::test(start_paused = true)]
async fn a_path_probe_does_not_suspend_an_older_heartbeat_timeout() {
    let mut phone = Phone::new(Route::Lan, None);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    advance(Duration::from_secs(15)).await;
    assert!(matches!(read(&mut dial.peer).await, Message::Ping { .. }));
    advance(Duration::from_secs(29)).await;
    phone.source.network_changed_with(BOTH_UP);
    assert!(matches!(read(&mut dial.peer).await, Message::Ping { .. }));
    eof(&mut dial.peer).await;
    assert_eq!(
        phone.status.borrow().error.as_deref(),
        Some("remote application heartbeat timed out")
    );
}

#[tokio::test(start_paused = true)]
async fn a_blocked_ingest_does_not_delay_a_path_ping_or_its_deadline() {
    let mirror = FakeMirror::new(MINUTE_TIERS);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::new(Route::Lan, Some(mirror));
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
    let mut phone = Phone::new(Route::Lan, None);
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
    let mut phone = Phone::new(Route::Lan, None);
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
    let mut phone = Phone::new(Route::Lan, None);
    let handle = phone.start();
    let mut dial = phone.connect().await;
    dial.writes.remaining.store(0, Ordering::Relaxed);
    handle.control().set_detail_interest(true);
    timeout(WAIT, dial.writes.stalled.notified()).await.unwrap();
    let changed = Instant::now();
    phone.source.network_changed_with(BOTH_UP);
    assert!(
        matches!(timeout(NETWORK_CHANGE_PROBE + WAIT, codec::read(&mut dial.peer)).await.unwrap(),
        Err(RemoteError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof)
    );
    assert_eq!(phone.next_dial().await.at - changed, NETWORK_CHANGE_PROBE);
}

#[tokio::test(start_paused = true)]
async fn a_route_preserving_change_gives_a_pending_flush_time_to_finish() {
    let mut phone = Phone::new(Route::Lan, None);
    let handle = phone.start();
    let mut dial = phone.connect().await;
    dial.writes.flush.lock_ok().blocked = true;
    handle.control().set_detail_interest(true);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if interest.detail));
    timeout(WAIT, dial.writes.stalled.notified()).await.unwrap();
    phone.source.network_changed_with(BOTH_UP);
    silence(&mut dial.peer).await;
    dial.writes.release_flush();
    let ping = read(&mut dial.peer).await;
    pong(&mut dial.peer, ping).await;
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(interest) if interest.detail));
    assert!(phone.dial.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn a_network_change_while_draining_rejects_the_older_promotion() {
    let mirror = FakeMirror::new(MINUTE_TIERS);
    let (entered, release) = mirror.block_next_ingest();
    let mut phone = Phone::with_routes(
        &[
            (Route::Lan, "studio.local"),
            (Route::Tailscale, "studio.tail"),
        ],
        Some(mirror),
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
    let mut phone = Phone::new(Route::Lan, None);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    let changed = Instant::now();
    phone.source.network_changed_with(BOTH_UP);
    let old = read(&mut dial.peer).await;
    advance(Duration::from_secs(1)).await;
    phone.source.network_changed_with(BOTH_UP);
    let new = read(&mut dial.peer).await;
    assert!(matches!(new, Message::Ping { .. }));
    assert_ne!(old, new);
    pong(&mut dial.peer, old).await;
    advance(NETWORK_CHANGE_PROBE - changed.elapsed()).await;
    eof(&mut dial.peer).await;
    let redial = timeout(WAIT, phone.dial.recv()).await.unwrap().unwrap();
    assert_eq!(redial.at - changed, NETWORK_CHANGE_PROBE);
}

#[tokio::test(start_paused = true)]
async fn unknown_network_leaves_the_stream_running_without_a_path_probe() {
    let mut phone = Phone::new(Route::Lan, None);
    let _handle = phone.start();
    let mut dial = phone.connect().await;
    phone.source.report_network_change(UNKNOWN_NETWORK);
    assert!(matches!(read(&mut dial.peer).await, Message::Interest(_)));
    advance(NETWORK_CHANGE_PROBE + Duration::from_secs(1)).await;
    silence(&mut dial.peer).await;
    assert!(phone.dial.try_recv().is_err());
    assert!(phone.status.borrow().connected);
}
