//! OpenSSH conformance against the Linux agent started by `make ssh-docker-test`.
use statglass_remote::{Endpoint, OpenSshDialer, RemoteCommand, Route, Target};
use statglass_schema::HostId;
use statglass_session::conformance::{self, ConformanceHost};
use std::{env, sync::Arc};
use uuid::Uuid;

fn fixture_var(name: &str) -> String {
    env::var(name).unwrap_or_else(|error| panic!("make ssh-docker-test supplies {name}: {error}"))
}

fn fixture() -> (OpenSshDialer, ConformanceHost) {
    let config = fixture_var("STATGLASS_SSH_DOCKER_SSH_CONFIG");
    let bin = fixture_var("STATGLASS_SSH_DOCKER_AGENT_BIN");
    let socket = fixture_var("STATGLASS_SSH_DOCKER_SOCKET");
    let host_id = HostId(
        Uuid::parse_str(&fixture_var("STATGLASS_SSH_DOCKER_HOST_ID"))
            .unwrap_or_else(|error| panic!("invalid STATGLASS_SSH_DOCKER_HOST_ID: {error}")),
    );
    let endpoint = |socket| Endpoint {
        targets: vec![Target {
            route: Route::Lan,
            host: "statglass-docker".into(),
        }],
        port: None,
        user: None,
        host_keys: Vec::new(),
        command: RemoteCommand::Agent {
            bin: bin.clone(),
            system: false,
            socket: Some(socket),
        },
    };
    let stopped = endpoint(format!("{socket}.stopped"));
    (
        OpenSshDialer::with_config_file(config),
        ConformanceHost {
            endpoint: endpoint(socket),
            stopped,
            host_id,
        },
    )
}

#[tokio::test]
#[ignore = "requires the sshd and agent from make ssh-docker-test"]
async fn live_session() {
    let (dialer, host) = fixture();
    conformance::live_session(&dialer, &host).await;
}

#[tokio::test]
#[ignore = "requires the sshd and agent from make ssh-docker-test"]
async fn agent_not_running() {
    let (dialer, host) = fixture();
    conformance::agent_not_running(&dialer, &host).await;
}

#[tokio::test]
#[ignore = "requires the sshd and agent from make ssh-docker-test"]
async fn source_syncs_mirror() {
    let (dialer, host) = fixture();
    conformance::source_syncs_mirror(Arc::new(dialer), &host).await;
}
