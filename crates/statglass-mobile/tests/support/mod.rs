use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use std::{env, fs};

use serde_json::{Value, json};
use statglass_ipc::mobile::{MobileCommand, MobileHost, MobileHostKey, MobileTarget};
use statglass_ipc::status::RemoteRoute;
use statglass_schema::{HostId, MetricId, SeriesKey, SeriesSelector};
use statglass_ssh::SoftwareSigner;
use tokio::sync::{Notify, mpsc};
use tokio::time::timeout;

use super::CoreEvents;

pub struct Events {
    live: mpsc::UnboundedSender<(u32, Value)>,
    status: Notify,
}

impl CoreEvents for Events {
    fn live(&self, stream: u32, message: String) -> bool {
        self.live
            .send((stream, serde_json::from_str(&message).expect("live JSON")))
            .is_ok()
    }

    fn event(&self, message: String) {
        let event: Value = serde_json::from_str(&message).expect("event JSON");
        if event["kind"] == "remote_hosts_changed" {
            self.status.notify_one();
        }
    }
}

pub struct DockerFixture {
    pub host: MobileHost,
    pub key: Arc<SoftwareSigner>,
    pub events: Arc<Events>,
    pub dir: tempfile::TempDir,
    live: mpsc::UnboundedReceiver<(u32, Value)>,
}

impl DockerFixture {
    pub fn new() -> Self {
        let env = |name: &str| {
            let var = format!("STATGLASS_SSH_DOCKER_{name}");
            env::var(&var)
                .unwrap_or_else(|error| panic!("{var}: {error}. Run make ssh-docker-test"))
        };
        let der = fs::read(env("KEY")).expect("read the fixture signing key");
        let key = SoftwareSigner::from_pkcs8_der(&der).expect("decode the fixture P-256 key");
        let pin = env("HOST_KEY");
        let (algorithm, sha256) = pin
            .split_once(' ')
            .expect("host key algorithm and fingerprint");
        let host = MobileHost {
            id: HostId(env("HOST_ID").parse().expect("agent's host UUID")),
            name: "Docker agent".into(),
            user: env("USER"),
            port: Some(env("PORT").parse().expect("sshd port")),
            targets: vec![MobileTarget {
                route: RemoteRoute::Lan,
                host: env("HOST"),
            }],
            host_keys: vec![MobileHostKey {
                algorithm: algorithm.into(),
                sha256: sha256.into(),
            }],
            command: MobileCommand::Agent {
                bin: env("AGENT_BIN"),
                system: false,
                socket: Some(env("SOCKET")),
            },
        };
        let (send, live) = mpsc::unbounded_channel();
        Self {
            host,
            key: Arc::new(key),
            events: Arc::new(Events {
                live: send,
                status: Notify::new(),
            }),
            dir: tempfile::tempdir().expect("phone data directory"),
            live,
        }
    }

    pub async fn expect_cpu(&mut self, stream: u32) {
        timeout(Duration::from_secs(15), async {
            let mut cpu = None;
            loop {
                let (id, message) = self.live.recv().await.expect("live sender is still open");
                assert_eq!(id, stream);
                if message["kind"] == "layout" {
                    let series: Vec<SeriesKey> =
                        serde_json::from_value(message["series"].clone()).expect("layout series");
                    cpu = series
                        .iter()
                        .position(|key| key.metric.as_str() == "cpu.total")
                        .map(|index| (message["layout_no"].clone(), index));
                }
                if message["kind"] == "frame"
                    && let Some((layout, index)) = &cpu
                    && message["layout_no"] == *layout
                    && let Some(value) = message["values"][index].as_f64()
                {
                    assert!((0.0..=100.0).contains(&value), "CPU percentage {value}");
                    return;
                }
            }
        })
        .await
        .expect("the Linux agent sends measured cpu.total through CoreEvents");
    }

    pub async fn expect_minute_history<F, Fut>(&self, mut call: F)
    where
        F: FnMut(&'static str, Value) -> Fut,
        Fut: Future<Output = Value>,
    {
        timeout(Duration::from_secs(60), async {
            loop {
                let hosts = call("list_remote_hosts", Value::Null).await;
                assert_eq!(hosts[0]["id"], json!(self.host.id));
                if let Some(through) = hosts[0]["synced_through_ms"].as_i64() {
                    let cpu = SeriesSelector {
                        metric: MetricId::parse("cpu.total").expect("CPU metric"),
                        labels: Default::default(),
                    };
                    let page = call(
                        "query_history",
                        json!({
                            "host": self.host.id, "tier": "m1", "max_points": 120,
                            "selectors": [cpu],
                            "from_ms": through - 3_600_000, "to_ms": through,
                        }),
                    )
                    .await;
                    assert_eq!(page["tier"], "m1");
                    if page["series"]
                        .as_array()
                        .expect("history series")
                        .iter()
                        .any(|series| {
                            series["key"]["metric"] == "cpu.total"
                                && series["points"]
                                    .as_array()
                                    .is_some_and(|points| !points.is_empty())
                        })
                    {
                        return;
                    }
                }
                self.events.status.notified().await;
            }
        })
        .await
        .expect("the core reads M1 CPU after the mirror records its watermark");
    }
}
