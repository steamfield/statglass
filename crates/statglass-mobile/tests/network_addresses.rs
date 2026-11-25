mod support;

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use serde_json::{Value, json};
use statglass_ipc::mobile::{MobileCommand, MobileConfig};
use statglass_mobile::{CoreEvents, MobileCore, NativeSigner, NativeSignerError};
use statglass_schema::HostId;
use statglass_ssh::{Signer, SoftwareSigner};
use tokio::runtime::Runtime;

use support::DockerFixture;

struct NativeKey(Arc<SoftwareSigner>);

impl NativeSigner for NativeKey {
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
        result.map_err(|error| NativeSignerError::Unexpected {
            message: error.to_string(),
        })
    }
}

fn data(envelope: &str) -> Value {
    let result: Value = serde_json::from_str(envelope).expect("core response envelope");
    assert_eq!(result["status"], "ok", "{result}");
    result["data"].clone()
}

async fn addresses(core: &MobileCore, host: HostId) -> Value {
    let answer = core
        .call(
            "network_addresses".into(),
            json!({ "host": host }).to_string(),
        )
        .await;
    data(&answer)
}

fn container_ip() -> Ipv4Addr {
    let container = std::env::var("STATGLASS_SSH_DOCKER_CONTAINER").expect("Docker container name");
    let result = std::process::Command::new("docker")
        .args([
            "inspect",
            "--format",
            "{{(index .NetworkSettings.Networks \"bridge\").IPAddress}}",
            &container,
        ])
        .output()
        .expect("inspect the agent container");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout)
        .expect("Docker output")
        .trim()
        .parse()
        .expect("container IPv4 address")
}

#[test]
#[ignore = "requires the restricted key and Linux agent from make ssh-docker-test"]
fn addresses_from_the_restricted_linux_agent() {
    let mut fixture = DockerFixture::new();
    fixture.host.command = MobileCommand::Restricted;
    let key = std::env::var_os("STATGLASS_SSH_DOCKER_RESTRICTED_KEY").unwrap();
    let der = std::fs::read(key).unwrap();
    fixture.key = Arc::new(SoftwareSigner::from_pkcs8_der(&der).unwrap());
    let core = MobileCore::new(
        Arc::new(NativeKey(fixture.key.clone())),
        fixture.events.clone(),
    );
    assert!(
        data(
            &core.start(
                fixture.dir.path().to_str().unwrap().into(),
                serde_json::to_string(&MobileConfig {
                    hosts: vec![fixture.host.clone()],
                    ..Default::default()
                })
                .unwrap(),
            )
        )
        .is_null()
    );

    let host = fixture.host.id;
    let expected_ip = container_ip().to_string();
    Runtime::new().unwrap().block_on(async {
        assert_eq!(
            data(
                &core
                    .call(
                        "set_demand".into(),
                        json!({"demand": [{"host": host, "level": "full"}]}).to_string()
                    )
                    .await
            ),
            Value::Null
        );
        let stream = core
            .call(
                "subscribe_live".into(),
                json!({ "host": host, "stream": 1, "backfill_ms": 0 }).to_string(),
            )
            .await;
        assert_eq!(data(&stream)["stream"], 1);
        fixture.expect_cpu(1).await;

        let answer = addresses(&core, host).await;
        assert_eq!(answer["interface"], "eth0", "{answer}");
        assert!(
            answer["ipv4"]
                .as_array()
                .unwrap()
                .contains(&json!(expected_ip))
        );
        for ip in answer["ipv6"].as_array().unwrap() {
            assert!(
                !ip.as_str()
                    .unwrap()
                    .parse::<Ipv6Addr>()
                    .unwrap()
                    .is_unicast_link_local()
            );
        }
        assert!(answer["as_of_ms"].as_i64().unwrap() > 0);
        assert_eq!(answer["public_ip"], json!({"state": "pending"}));

        let public_ip = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let answer = addresses(&core, host).await;
                if answer["public_ip"]["state"] != "pending" {
                    return answer["public_ip"].clone();
                }
            }
        })
        .await
        .expect("the lookup finishes");
        assert_eq!(
            public_ip,
            json!({
                "state": "unavailable", "detail": {"reason": "curl not installed"}
            })
        );
    });
}
