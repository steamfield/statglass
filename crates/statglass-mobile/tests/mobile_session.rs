mod support;

use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use serde_json::{Value, json};
use statglass_ipc::mobile::{MobileCommand, MobileConfig, MobileHost, MobileHostKey, MobileTarget};
use statglass_ipc::status::RemoteRoute;
use statglass_mobile::{CoreEvents, MobileCore, NativeSigner, NativeSignerError};
use statglass_schema::{HostId, SeriesKey, SeriesSelector, Tier};
use statglass_ssh::{Signer, SoftwareSigner};
use tokio::runtime::Runtime;
use tokio::sync::watch;

use support::DockerFixture;

struct SoftwareNativeKey(Arc<SoftwareSigner>);

impl NativeSigner for SoftwareNativeKey {
    fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
        Ok(self.0.public_key().to_vec())
    }

    fn sign(&self, message: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
        let mut signing = self.0.sign(message);
        let Poll::Ready(result) = signing
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        else {
            panic!("the software key signs synchronously");
        };
        result.map_err(|error| NativeSignerError::Refused {
            message: error.to_string(),
        })
    }
}

fn data(envelope: &str) -> Value {
    let result: Value = serde_json::from_str(envelope).expect("core response envelope");
    assert_eq!(result["status"], "ok", "{result}");
    result["data"].clone()
}

struct NoEvents;

impl CoreEvents for NoEvents {
    fn live(&self, _: u32, _: String) -> bool {
        false
    }

    fn event(&self, _: String) {}
}

struct UnavailableKey;

impl NativeSigner for UnavailableKey {
    fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
        Err(NativeSignerError::Unavailable {
            message: "Keychain is locked".into(),
        })
    }

    fn sign(&self, _: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
        panic!("an unavailable key cannot sign");
    }
}

fn paired_host() -> MobileHost {
    MobileHost {
        id: HostId(
            "00000000-0000-0000-0000-000000000001"
                .parse()
                .expect("fixture host UUID"),
        ),
        name: "Paired host".into(),
        user: "monitor".into(),
        port: None,
        targets: vec![MobileTarget {
            route: RemoteRoute::Lan,
            host: "monitor.local".into(),
        }],
        host_keys: vec![MobileHostKey {
            algorithm: "ssh-ed25519".into(),
            sha256: "SHA256:fixture".into(),
        }],
        command: MobileCommand::Restricted,
    }
}

fn start_host(core: &MobileCore, dir: &tempfile::TempDir, host: MobileHost) {
    let config = MobileConfig {
        hosts: vec![host],
        ..Default::default()
    };
    assert_eq!(
        data(&core.start(
            dir.path().display().to_string(),
            serde_json::to_string(&config).expect("mobile config JSON"),
        )),
        Value::Null
    );
}

#[test]
fn an_unavailable_native_key_is_a_host_open_error() {
    let dir = tempfile::tempdir().unwrap();
    let core = MobileCore::new(Arc::new(UnavailableKey), Arc::new(NoEvents));
    let host = paired_host();
    let id = host.id;
    start_host(&core, &dir, host);
    Runtime::new().unwrap().block_on(async {
        let rows = data(&core.call("list_remote_hosts".into(), "".into()).await);
        let error = json!({
            "kind": "internal",
            "message": "reading the phone's SSH public key: signing key unavailable: Keychain is locked",
        });
        assert_eq!(rows[0]["connection"]["state"], "error");
        assert_eq!(rows[0]["connection"]["failure"], "phone_key_unavailable");
        assert_eq!(rows[0]["open_error"], error);
        let retried: Value = serde_json::from_str(
            &core.call("retry_remote_host".into(), json!({"host": id}).to_string()).await,
        ).unwrap();
        assert_eq!(retried, json!({"status": "error", "error": error}));
    });
}

#[test]
fn a_missing_host_key_pin_is_a_host_open_error() {
    let dir = tempfile::tempdir().unwrap();
    let core = MobileCore::new(
        Arc::new(SoftwareNativeKey(Arc::new(SoftwareSigner::generate()))),
        Arc::new(NoEvents),
    );
    let mut host = paired_host();
    host.host_keys.clear();
    start_host(&core, &dir, host);
    Runtime::new().unwrap().block_on(async {
        let rows = data(&core.call("list_remote_hosts".into(), "".into()).await);
        assert_eq!(rows[0]["connection"]["state"], "error");
        assert_eq!(
            rows[0]["open_error"],
            json!({
                "kind": "invalid_argument", "message": "a paired SSH host key is required",
            })
        );
    });
}

#[test]
fn mobile_core_reports_empty_and_missing_hosts_through_json() {
    let dir = tempfile::tempdir().unwrap();
    let core = MobileCore::new(
        Arc::new(SoftwareNativeKey(Arc::new(SoftwareSigner::generate()))),
        Arc::new(NoEvents),
    );
    let config = serde_json::to_string(&MobileConfig::default()).unwrap();
    let path = dir.path().to_str().unwrap().to_owned();
    assert_eq!(data(&core.start(path.clone(), config.clone())), Value::Null);
    let second: Value = serde_json::from_str(&core.start(path, config)).unwrap();
    assert_eq!(second["error"]["kind"], "internal");
    Runtime::new().unwrap().block_on(async {
        assert_eq!(
            data(&core.call("list_hosts".into(), "".into()).await),
            json!([])
        );
        assert_eq!(
            data(&core.call("list_remote_hosts".into(), "null".into()).await),
            json!([])
        );
        let host = "00000000-0000-0000-0000-000000000001";
        let absent: Value = serde_json::from_str(
            &core
                .call("get_host".into(), json!({ "host": host }).to_string())
                .await,
        )
        .unwrap();
        assert_eq!(
            absent,
            json!({"status": "error", "error": {"kind": "unknown_host", "host": host}})
        );
        assert_eq!(
            data(
                &core
                    .call(
                        "unsubscribe_live".into(),
                        json!({ "stream": 1 }).to_string()
                    )
                    .await
            ),
            Value::Null
        );
    });
}

#[test]
#[ignore = "requires the Linux agent and sshd fixture from make ssh-docker-test"]
fn mobile_core_streams_and_reads_host_history() {
    let mut fixture = DockerFixture::new();
    let (observed, mut frames) = watch::channel(0);
    let core = MobileCore::new(
        Arc::new(SoftwareNativeKey(fixture.key.clone())),
        Arc::new(ObserveFrames {
            sink: fixture.events.clone(),
            observed,
        }),
    );
    let config = MobileConfig {
        hosts: vec![fixture.host.clone()],
        ..Default::default()
    };
    assert!(
        data(&core.start(
            fixture.dir.path().to_str().unwrap().into(),
            serde_json::to_string(&config).unwrap(),
        ))
        .is_null()
    );
    Runtime::new().unwrap().block_on(async {
        let stream = 17;
        let info = core
            .call(
                "subscribe_live".into(),
                json!({ "host": fixture.host.id, "stream": stream }).to_string(),
            )
            .await;
        assert_eq!(data(&info)["stream"], stream);
        fixture.expect_cpu(stream).await;
        let width = Tier::S10.bucket_ms().unwrap();
        let next_bucket = (*frames.borrow() / width + 1) * width;
        // Wait for the agent to close a bucket containing a sampled frame.
        tokio::time::timeout(
            Duration::from_secs(20),
            frames.wait_for(|ts| *ts > next_bucket),
        )
        .await
        .unwrap()
        .unwrap();
        let from_ms = next_bucket - 60_000;
        let key = SeriesKey::parse("cpu.total").unwrap();
        let series = SeriesSelector {
            metric: key.metric.clone(),
            labels: key.labels.clone(),
        };
        let page = data(
            &core
                .call(
                    "host_history".into(),
                    json!({
                        "host": fixture.host.id, "series": [series], "from_ms": from_ms,
                        "to_ms": null, "max_points": 30, "events_for": "cpu",
                    })
                    .to_string(),
                )
                .await,
        );
        let points = page["series"][0]["points"]
            .as_array()
            .expect("CPU history points");
        assert_eq!(page["tier"], "s10");
        assert_eq!(page["series"][0]["key"], json!(key));
        assert!(!points.is_empty() && points.len() <= 30, "{page}");
        assert!(
            page["complete_to_ms"].as_i64().unwrap() >= next_bucket,
            "{page}"
        );
        assert!(
            points.iter().any(|point| {
                point["t"]
                    .as_i64()
                    .is_some_and(|time| (from_ms..next_bucket).contains(&time))
                    && point["avg"]
                        .as_f64()
                        .is_some_and(|value| (0.0..=100.0).contains(&value))
            }),
            "{page}"
        );
        assert!(!fixture.dir.path().join("mirrors").exists());
        assert!(data(&core.quiesce()).is_null());
        assert!(data(&core.quiesced().await).is_null());
    });
}

struct ObserveFrames {
    sink: Arc<dyn CoreEvents>,
    observed: watch::Sender<i64>,
}

impl CoreEvents for ObserveFrames {
    fn live(&self, stream: u32, message: String) -> bool {
        let value: Value = serde_json::from_str(&message).expect("live JSON");
        if value["kind"] == "frame"
            && let Some(ts) = value["ts_ms"].as_i64()
        {
            self.observed.send_replace(ts);
        }
        self.sink.live(stream, message)
    }

    fn event(&self, message: String) {
        self.sink.event(message);
    }
}
