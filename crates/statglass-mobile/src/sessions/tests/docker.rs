#[path = "../../../tests/support/mod.rs"]
mod support;

use statglass_ipc::mobile::MobileConfig;

use super::*;
use support::DockerFixture;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the Linux agent and sshd fixture from make ssh-docker-test"]
async fn mobile_session() {
    let mut fixture = DockerFixture::new();
    let sessions = Sessions::new(fixture.events.clone(), None);
    let host = fixture.host.id;
    sessions
        .start(
            Handle::current(),
            fixture.dir.path().into(),
            MobileConfig {
                hosts: vec![fixture.host.clone()],
                ..Default::default()
            },
            Arc::new(statglass_ssh::RusshDialer::new(fixture.key.clone())),
        )
        .unwrap();
    sessions
        .call(MobileCall::SetDemand {
            demand: vec![HostDemand {
                host,
                level: DemandLevel::Full,
            }],
        })
        .await
        .unwrap();
    sessions.call(subscribe(host, 17)).await.unwrap();
    fixture.expect_cpu(17).await;
    assert!(!fixture.dir.path().join("mirrors").exists());
}
