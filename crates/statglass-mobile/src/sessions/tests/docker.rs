#[path = "../../../tests/support/mod.rs"]
mod support;

use statglass_ipc::mobile::MobileConfig;

use super::*;
use support::DockerFixture;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the Linux agent and sshd fixture from make ssh-docker-test"]
async fn mobile_session() {
    let mut fixture = DockerFixture::new();
    let sessions = Sessions::new(fixture.events.clone());
    let host = fixture.host.id;
    sessions
        .start(
            Handle::current(),
            fixture.dir.path().into(),
            MobileConfig {
                hosts: vec![fixture.host.clone()],
                ..Default::default()
            },
            fixture.key.clone(),
        )
        .unwrap();
    sessions.call(subscribe(host, 17)).await.unwrap();
    fixture.expect_cpu(17).await;
    fixture
        .expect_minute_history(|method, args| {
            let sessions = &sessions;
            async move {
                let call = if args.is_null() {
                    json!({"method": method})
                } else {
                    json!({"method": method, "args": args})
                };
                sessions
                    .call(serde_json::from_value(call).unwrap())
                    .await
                    .unwrap()
            }
        })
        .await;
    let rows = sessions.call(MobileCall::ListRemoteHosts).await.unwrap();
    assert!(rows[0]["synced_through_ms"].is_i64());
}
