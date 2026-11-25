use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use statglass_ipc::mobile::{
    MobileCall, MobileCommand, MobileHost, MobileLiveRequest, MobileTarget,
};
use statglass_ipc::status::RemoteRoute;
use statglass_proto::{Hello, Message, WireLayout};
use statglass_schema::{Capabilities, HostId, SeriesKey, lock::LockExt};
use statglass_session::{
    BoxFuture, Close, DialFailure, DialedStream, Dialer, Endpoint, RemoteError, StderrTail,
    SyncPolicy, Target, codec,
};
use tokio::io::DuplexStream;
use tokio::runtime::Handle;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::timeout;

use super::{CoreEvents, Sessions, endpoint};
use crate::control::SessionControl;

mod docker;
mod history;
mod live;
mod registry;

pub(super) const WAIT: Duration = Duration::from_secs(5);
const NOW: i64 = 1_788_220_800_000;

pub(super) fn host(n: u8) -> MobileHost {
    MobileHost {
        id: HostId(format!("00000000-0000-0000-0000-{n:012x}").parse().unwrap()),
        name: format!("Mac {n}"),
        user: "monitor".into(),
        port: None,
        targets: vec![MobileTarget {
            route: RemoteRoute::Lan,
            host: format!("mac{n}.local"),
        }],
        host_keys: Vec::new(),
        command: MobileCommand::MacHelper {
            path: String::new(),
        },
    }
}

fn cpu() -> SeriesKey {
    SeriesKey::parse("cpu.total").unwrap()
}

fn subscribe(host: HostId, stream: u32) -> MobileCall {
    MobileCall::SubscribeLive(MobileLiveRequest {
        host,
        stream,
        backfill_ms: Some(0),
        series: None,
        min_period_ms: None,
    })
}

struct Recorder {
    live: mpsc::UnboundedSender<(u32, Value)>,
    events: Mutex<Vec<Value>>,
    refuse: Mutex<Option<&'static str>>,
    live_gate: Mutex<Option<CallbackGate>>,
    event_gate: Mutex<Option<CallbackGate>>,
    status_gate: Mutex<Option<CallbackGate>>,
    panic_live: Mutex<bool>,
    panic_event: Mutex<bool>,
    event_ready: Notify,
}

struct CallbackGate {
    entered: oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

impl CallbackGate {
    fn new() -> (Self, oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (entered, wait) = oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        (
            Self {
                entered,
                release: blocked,
            },
            wait,
            release,
        )
    }

    fn block(self) {
        let _ = self.entered.send(());
        let _ = self.release.recv_timeout(WAIT);
    }
}

impl CoreEvents for Recorder {
    fn live(&self, stream: u32, json: String) -> bool {
        let message: Value = serde_json::from_str(&json).unwrap();
        if message["kind"] == "frame" {
            assert!(
                !std::mem::take(&mut *self.panic_live.lock_ok()),
                "test live callback panic"
            );
            let gate = self.live_gate.lock_ok().take();
            if let Some(gate) = gate {
                gate.block();
            }
        }
        let delivered = self
            .refuse
            .lock_ok()
            .is_none_or(|kind| message["kind"] != kind);
        let _ = self.live.send((stream, message));
        delivered
    }

    fn event(&self, json: String) {
        let event: Value = serde_json::from_str(&json).unwrap();
        assert!(
            !std::mem::take(&mut *self.panic_event.lock_ok()),
            "test event callback panic"
        );
        if event["kind"] == "hosts_changed" {
            let gate = self.event_gate.lock_ok().take();
            if let Some(gate) = gate {
                gate.block();
            }
        }
        if event["kind"] == "remote_hosts_changed" {
            let gate = self.status_gate.lock_ok().take();
            if let Some(gate) = gate {
                gate.block();
            }
        }
        self.events.lock_ok().push(event);
        self.event_ready.notify_one();
    }
}

pub(super) struct Fixture {
    pub(super) sessions: Sessions,
    events: Arc<Recorder>,
    messages: mpsc::UnboundedReceiver<(u32, Value)>,
    pub(super) dials: mpsc::UnboundedReceiver<Dial>,
    dir: tempfile::TempDir,
}

impl Fixture {
    pub(super) fn start(hosts: Vec<MobileHost>, sync: SyncPolicy) -> Self {
        Self::start_in(tempfile::tempdir().unwrap(), hosts, sync)
    }

    fn start_in(dir: tempfile::TempDir, hosts: Vec<MobileHost>, sync: SyncPolicy) -> Self {
        let (live, messages) = mpsc::unbounded_channel();
        let events = Arc::new(Recorder {
            live,
            events: Mutex::default(),
            refuse: Mutex::default(),
            live_gate: Mutex::default(),
            event_gate: Mutex::default(),
            status_gate: Mutex::default(),
            panic_live: Mutex::default(),
            panic_event: Mutex::default(),
            event_ready: Notify::new(),
        });
        let sessions = Sessions::new(events.clone());
        if sync != SyncPolicy::Full {
            sessions.set_sync_policy(sync);
        }
        let (dials, connections) = mpsc::unbounded_channel();
        sessions
            .registry
            .start(
                Handle::current(),
                dir.path().into(),
                hosts,
                Arc::new(PeerDialer(dials)),
            )
            .unwrap();
        Self {
            sessions,
            events,
            messages,
            dials: connections,
            dir,
        }
    }

    pub(super) async fn next_dial(&mut self) -> Dial {
        timeout(WAIT, self.dials.recv())
            .await
            .expect("next dial")
            .unwrap()
    }

    async fn message(&mut self, kind: &str) -> (u32, Value) {
        timeout(WAIT, async {
            loop {
                let (stream, msg) = self.messages.recv().await.unwrap();
                if msg["kind"] == kind {
                    return (stream, msg);
                }
            }
        })
        .await
        .expect("expected a live message")
    }

    async fn next_roster(&self) -> Vec<HostId> {
        timeout(WAIT, async {
            loop {
                if let Some(event) = self
                    .events
                    .events
                    .lock_ok()
                    .iter()
                    .find(|event| event["kind"] == "hosts_changed")
                {
                    return ids(event["hosts"].clone());
                }
                self.events.event_ready.notified().await;
            }
        })
        .await
        .expect("host roster event")
    }
}

struct PeerDialer(mpsc::UnboundedSender<Dial>);

pub(super) struct Dial {
    peer: DuplexStream,
    pub(super) target: String,
    pub(super) closing: oneshot::Receiver<()>,
    pub(super) finish_close: oneshot::Sender<()>,
}

struct CloseGate(oneshot::Sender<()>, oneshot::Receiver<()>);

impl Close for CloseGate {
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let _ = self.0.send(());
            let _ = self.1.await;
        })
    }
}

impl Dialer for PeerDialer {
    fn dial<'a>(
        &'a self,
        _: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, statglass_session::Result<DialedStream>> {
        Box::pin(async move {
            let (client, peer) = tokio::io::duplex(65536);
            let (close, closing) = oneshot::channel();
            let (finish_close, wait) = oneshot::channel();
            self.0
                .send(Dial {
                    peer,
                    target: target.host.clone(),
                    closing,
                    finish_close,
                })
                .map_err(|_| RemoteError::Transport("test no longer accepts connections".into()))?;
            let (reader, writer) = tokio::io::split(client);
            Ok(DialedStream {
                reader: Box::pin(reader),
                writer: Box::pin(writer),
                stderr: StderrTail::default(),
                close: Box::new(CloseGate(close, wait)),
            })
        })
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        RemoteError::Transport(failure.outcome.sentence().into())
    }
}

impl Dial {
    pub(super) async fn handshake(&mut self, host: &MobileHost) -> statglass_proto::RemoteInterest {
        codec::write(
            &mut self.peer,
            &Message::Hello(Box::new(Hello {
                proto_version: statglass_proto::PROTO_VERSION,
                min_compatible: statglass_proto::MIN_COMPATIBLE,
                app_version: "fixture".into(),
                host: endpoint::record(host).identity(),
                db_instance_uuid: host.id.0,
                capabilities: Capabilities {
                    revision: 5,
                    ..Default::default()
                },
                features: statglass_proto::local_features(),
            })),
        )
        .await
        .unwrap();
        assert!(matches!(self.read().await, Message::HelloAck(_)));
        let Message::Interest(interest) = self.read().await else {
            panic!("expected the initial source interest");
        };
        interest
    }

    async fn read(&mut self) -> Message {
        timeout(WAIT, codec::read(&mut self.peer))
            .await
            .unwrap()
            .unwrap()
    }

    async fn layout(&mut self) {
        codec::write(
            &mut self.peer,
            &Message::LayoutDef(WireLayout {
                layout_no: 17,
                series: vec![cpu()],
            }),
        )
        .await
        .unwrap();
    }

    async fn frame(&mut self, ts_ms: i64, value: f32) {
        codec::write(
            &mut self.peer,
            &Message::Live(statglass_proto::LiveFrame {
                ts_ms,
                layout_no: 17,
                values: vec![value],
                held: vec![value],
                interval_ms: 1_000,
                timeline: 0,
                holds: vec![2_500],
            }),
        )
        .await
        .unwrap();
    }
}

fn ids(records: Value) -> Vec<HostId> {
    serde_json::from_value::<Vec<statglass_schema::HostRecord>>(records)
        .unwrap()
        .into_iter()
        .map(|record| record.id)
        .collect()
}

fn remote_changed() -> Value {
    json!({"kind": "remote_hosts_changed"})
}
