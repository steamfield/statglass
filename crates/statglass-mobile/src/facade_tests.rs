//! The JSON facade over an in-process peer, without a network or native key.

use std::{future::Future, sync::Arc, time::Duration};

use serde_json::{Value, json};
use statglass_ipc::{error::CommandError, mobile::MobileConfig};
use statglass_proto::{Answer, HistoryAnswer, HistoryQuery, Message, Query, WireHistorySeries};
use statglass_schema::{SeriesKey, SeriesSelector, Tier};
use statglass_session::{
    BoxFuture, DialFailure, DialedStream, Dialer, Endpoint, RemoteCommand, RemoteError, Route,
    Target, codec,
};
use tokio::{runtime::Builder, sync::mpsc, time::timeout};

use crate::sessions::tests::{Dial, PeerDialer};
use crate::{CoreEvents, MobileCore, NativeSigner, NativeSignerError, envelope};

const WAIT: Duration = Duration::from_secs(5);
const HOST: &str = "00000000-0000-0000-0000-000000000001";
const ADDRESS: &str = "mac.local";
const NOW: i64 = 1_788_220_800_000;
const STREAM: u32 = 17;

struct UnusedSigner;

impl NativeSigner for UnusedSigner {
    fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
        panic!("the scripted dialer does not read a key");
    }

    fn sign(&self, _: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
        panic!("the scripted dialer does not sign");
    }
}

struct Events {
    live: mpsc::UnboundedSender<(u32, Value)>,
    status: mpsc::UnboundedSender<()>,
}

impl CoreEvents for Events {
    fn live(&self, stream: u32, message: String) -> bool {
        self.live.send((stream, decode(&message))).is_ok()
    }

    fn event(&self, event: String) {
        if decode(&event)["kind"] == "remote_hosts_changed" {
            let _ = self.status.send(());
        }
    }
}

fn config() -> MobileConfig {
    serde_json::from_value(json!({
        "hosts": [{
            "id": HOST, "name": "Mac", "user": "monitor",
            "targets": [{"route": "lan", "host": ADDRESS}],
            "host_keys": [], "command": {"kind": "mac_helper", "path": ""}
        }],
        "data": {"live_on_cellular": false}
    }))
    .unwrap()
}

fn start(core: &MobileCore, dir: &tempfile::TempDir, config: &MobileConfig) {
    assert_eq!(
        decode(&core.start(
            dir.path().to_str().unwrap().into(),
            serde_json::to_string(config).unwrap(),
        )),
        success(Value::Null)
    );
}

fn run(test: impl Future<Output = ()>) {
    // The facade owns a separate runtime. Drop it on this test thread after block_on.
    Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test);
}

fn decode(json: &str) -> Value {
    serde_json::from_str(json).expect("valid facade JSON")
}

fn success(data: Value) -> Value {
    json!({"status": "ok", "data": data})
}

async fn next<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
    timeout(WAIT, receiver.recv())
        .await
        .expect("callback or peer reached the test")
        .expect("the sender is still running")
}

async fn expect_frame(messages: &mut mpsc::UnboundedReceiver<(u32, Value)>, time: i64, cpu: f32) {
    let (stream, frame) = timeout(WAIT, async {
        loop {
            let (stream, message) = messages.recv().await.expect("live callback still running");
            if message["kind"] == "frame" {
                break (stream, message);
            }
        }
    })
    .await
    .expect("a live frame reaches the callback");
    assert_eq!(stream, STREAM);
    assert_eq!(frame["ts_ms"], time);
    assert_eq!(frame["values"], json!([cpu]));
    assert_eq!(frame["held"], json!([cpu]));
}

#[test]
fn live_subscription_resumes_and_history_comes_from_the_peer() {
    let dir = tempfile::tempdir().unwrap();
    let config = config();
    let host = &config.hosts[0];
    let (dials, mut peers) = mpsc::unbounded_channel();
    let (live, mut messages) = mpsc::unbounded_channel();
    let (status, _statuses) = mpsc::unbounded_channel();
    let core = MobileCore::with_dialer(
        Arc::new(UnusedSigner),
        Arc::new(Events { live, status }),
        Arc::new(PeerDialer(dials)),
    );
    start(&core, &dir, &config);

    run(async {
        let mut peer = next(&mut peers).await;
        peer.handshake(host).await;
        let args = json!({"host": HOST, "stream": STREAM, "backfill_ms": 0});
        let subscribed = core.call("subscribe_live".into(), args.to_string()).await;
        assert_eq!(
            decode(&subscribed),
            success(json!({
                "host": HOST, "stream": STREAM, "backfill_start_ms": null,
                "recent_ms": statglass_ipc::live::RECENT_MS,
                "backfill_rows": 0, "earlier_start_ms": null, "earlier_rows": 0,
            }))
        );
        peer.layout().await;
        peer.frame(NOW, 11.).await;
        expect_frame(&mut messages, NOW, 11.).await;

        assert_eq!(decode(&core.quiesce()), success(Value::Null));
        timeout(WAIT, &mut peer.closing).await.unwrap().unwrap();
        peer.finish_close.send(()).unwrap();
        assert_eq!(
            decode(&timeout(WAIT, core.quiesced()).await.unwrap()),
            success(Value::Null)
        );

        assert_eq!(decode(&core.resume()), success(Value::Null));
        let mut resumed = next(&mut peers).await;
        resumed.handshake(host).await;
        resumed.layout().await;
        resumed.frame(NOW + 1_000, 23.).await;
        expect_frame(&mut messages, NOW + 1_000, 23.).await;
        timeout(WAIT, assert_history(&core, &mut resumed))
            .await
            .expect("the resumed peer answers the history request");
    });
}

async fn assert_history(core: &MobileCore, peer: &mut Dial) {
    let key = SeriesKey::parse("cpu.total").unwrap();
    let query = HistoryQuery {
        series: vec![SeriesSelector {
            metric: key.metric.clone(),
            labels: key.labels.clone(),
        }],
        from_ms: NOW - 10_000,
        to_ms: Some(NOW),
        max_points: 30,
        events_for: Some(statglass_schema::Module::Cpu),
    };
    let mut args = serde_json::to_value(&query).unwrap();
    args["host"] = json!(HOST);
    let call = core.call("host_history".into(), args.to_string());
    tokio::pin!(call);
    let id = loop {
        let message = tokio::select! {
            result = &mut call => panic!("host_history returned before the peer's reply: {result}"),
            message = peer.read() => message,
        };
        if let Message::Request { id, query: actual } = message {
            assert_eq!(actual, Query::History(query));
            break id;
        }
    };
    let t = NOW - 10_000;
    codec::write(
        &mut peer.peer,
        &Message::Reply {
            id,
            answer: Answer::History(HistoryAnswer {
                tier: Tier::S10,
                bucket_ms: 10_000,
                complete_to_ms: NOW,
                series: vec![WireHistorySeries {
                    key: key.clone(),
                    points: vec![(t, 11., 7., 19.)],
                    hold_ms: 10_000,
                }],
                gaps: vec![],
                events: vec![],
                stats: vec![],
                clamped: vec![],
            }),
        },
    )
    .await
    .unwrap();
    let reply = timeout(WAIT, call).await.unwrap();
    assert_eq!(
        decode(&reply),
        success(json!({
            "tier": "s10", "bucket_ms": 10_000, "complete_to_ms": NOW,
            "series": [{
                "key": key, "points": [{"t": t, "avg": 11.0, "min": 7.0, "max": 19.0}],
                "hold_ms": 10_000,
            }],
            "gaps": [], "events": [], "stats": [], "clamped": [],
        }))
    );
}

struct RefusedKey;

impl Dialer for RefusedKey {
    fn dial<'a>(
        &'a self,
        _: &'a Endpoint,
        _: &'a Target,
    ) -> BoxFuture<'a, statglass_session::Result<DialedStream>> {
        Box::pin(async { Err(RemoteError::Authentication("key refused".into())) })
    }

    fn classify(&self, _: &DialFailure<'_>) -> RemoteError {
        panic!("authentication failed before the StatGlass handshake");
    }
}

#[test]
fn a_refused_key_reaches_the_facade_as_authentication() {
    let dir = tempfile::tempdir().unwrap();
    let config = config();
    let (live, _messages) = mpsc::unbounded_channel();
    let (status, mut statuses) = mpsc::unbounded_channel();
    let dialer = Arc::new(RefusedKey);
    let core = MobileCore::with_dialer(
        Arc::new(UnusedSigner),
        Arc::new(Events { live, status }),
        dialer.clone(),
    );
    start(&core, &dir, &config);

    run(async {
        // Start acknowledges registration. The subsequent dial result is in host status.
        let row = timeout(WAIT, async {
            loop {
                statuses
                    .recv()
                    .await
                    .expect("status callback still running");
                let reply = decode(&core.call("list_remote_hosts".into(), "null".into()).await);
                assert_eq!(reply["status"], "ok", "{reply}");
                let row = &reply["data"][0];
                if !row["connection"]["failure"].is_null() {
                    break row.clone();
                }
            }
        })
        .await
        .expect("the dial failure reaches the remote host list");
        assert_eq!(row["id"], HOST);
        assert_eq!(row["connection"]["state"], "error");
        assert_eq!(row["connection"]["failure"], "authentication");

        // Commands use the shared error conversion when they return a dial failure.
        let host = &config.hosts[0];
        let endpoint = Endpoint {
            targets: vec![Target {
                route: Route::Lan,
                host: ADDRESS.into(),
            }],
            port: host.port,
            user: Some(host.user.clone()),
            host_keys: vec![],
            command: RemoteCommand::MacHelper(String::new()),
        };
        let result = statglass_session::connect(&*dialer, &endpoint, host.id, None)
            .await
            .map(|_| ())
            .map_err(CommandError::from);
        let error = decode(&envelope::encode(result));
        assert_eq!(error["status"], "error");
        assert_eq!(error["error"]["kind"], "remote_auth");
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("key refused")
        );
    });
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub(super) fn new_unstarted_core() -> Arc<MobileCore> {
    let (live, _messages) = mpsc::unbounded_channel();
    let (status, _statuses) = mpsc::unbounded_channel();
    MobileCore::new(Arc::new(UnusedSigner), Arc::new(Events { live, status }))
}
