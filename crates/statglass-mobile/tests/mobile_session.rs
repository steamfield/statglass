mod support;

use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use serde_json::{Value, json};
use statglass_ipc::mobile::MobileConfig;
use statglass_mobile::{CoreEvents, MobileCore, NativeSigner, NativeSignerError};
use statglass_ssh::{Signer, SoftwareSigner};
use tokio::runtime::Runtime;

use support::DockerFixture;

struct SoftwareNativeKey(Arc<SoftwareSigner>);

impl NativeSigner for SoftwareNativeKey {
    fn public_key(&self) -> Vec<u8> {
        self.0.public_key().to_vec()
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
    assert_eq!(second["error"]["kind"], "invalid_argument");
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
fn mobile_core_streams_and_reads_its_mirror() {
    let mut fixture = DockerFixture::new();
    let core = MobileCore::new(
        Arc::new(SoftwareNativeKey(fixture.key.clone())),
        fixture.events.clone(),
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
        fixture
            .expect_minute_history(|method, args| {
                let core = &core;
                async move { data(&core.call(method.into(), args.to_string()).await) }
            })
            .await;
        assert!(data(&core.quiesce().await).is_null());
    });
}
