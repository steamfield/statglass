use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use statglass_ipc::mobile::{MobileCommand, MobileConfig, MobileHost, MobileHostKey, MobileTarget};
use statglass_ipc::status::RemoteRoute;
use statglass_mobile::{CoreEvents, MobileCore, NativeSigner, NativeSignerError};
use statglass_schema::HostId;
use statglass_ssh::SoftwareSigner;
use tokio::net::TcpListener;
use tokio::time::timeout;

struct Phone(SoftwareSigner);

impl NativeSigner for Phone {
    fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
        Ok(self.0.public_key().to_vec())
    }

    fn sign(&self, _: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
        panic!("the socket probe never negotiates SSH authentication");
    }
}

impl CoreEvents for Phone {
    fn live(&self, _: u32, _: String) -> bool {
        false
    }
    fn event(&self, _: String) {}
}

fn data(reply: String) -> Value {
    let decoded: Value = serde_json::from_str(&reply).expect("decode the facade response");
    assert_eq!(decoded["status"], "ok", "{decoded}");
    decoded["data"].clone()
}

async fn call(core: &MobileCore, method: &str, args: Value) -> Value {
    data(core.call(method.into(), args.to_string()).await)
}

#[test]
fn demand_for_a_host_added_in_background_reaches_ssh_only_after_foreground() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("create the test runtime");
    let phone = Arc::new(Phone(SoftwareSigner::generate()));
    let core = MobileCore::new(phone.clone(), phone);
    let dir = tempfile::tempdir().expect("phone data directory");
    data(core.start(
        dir.path().to_str().expect("UTF-8 phone data path").into(),
        serde_json::to_string(&MobileConfig::default()).expect("serialize the default config"),
    ));
    runtime.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the SSH probe");
        let host = MobileHost {
            id: HostId(
                "00000000-0000-0000-0000-000000000001"
                    .parse()
                    .expect("parse the fixture host ID"),
            ),
            name: "Fixture".into(),
            user: "statglass".into(),
            port: Some(
                listener
                    .local_addr()
                    .expect("read the SSH probe address")
                    .port(),
            ),
            targets: vec![MobileTarget {
                route: RemoteRoute::Lan,
                host: "127.0.0.1".into(),
            }],
            host_keys: vec![MobileHostKey {
                algorithm: "ssh-ed25519".into(),
                sha256: format!("SHA256:{}", "A".repeat(43)),
            }],
            command: MobileCommand::Restricted,
        };
        data(core.quiesce());
        data(core.quiesced().await);
        call(&core, "set_hosts", json!({"hosts": [host]})).await;
        call(
            &core,
            "set_demand",
            json!({"demand": [{"host": host.id, "level": "compact"}]}),
        )
        .await;
        let status = call(&core, "list_remote_hosts", Value::Null).await;
        assert_eq!(status[0]["demand"], Value::Null);
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );

        data(core.resume());
        let (connection, _) = timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("the demanded host dials the SSH probe")
            .expect("accept the SSH connection");
        let status = call(&core, "list_remote_hosts", Value::Null).await;
        assert_eq!(status[0]["demand"], "compact");
        data(core.quiesce());
        data(core.quiesced().await);
        drop(connection);
    });
}
