#![cfg(feature = "software-signer")]
//! Run through `make ssh-docker-test`, which enables `software-signer` and starts sshd.

use statglass_schema::HostId;
use statglass_session::{
    Endpoint, PinnedHostKey, RemoteCommand, Route, Target,
    conformance::{self, ConformanceHost},
};
use statglass_ssh::{RusshDialer, SoftwareSigner};
use std::{env, fs, sync::Arc};

fn env(name: &str) -> String {
    env::var(format!("STATGLASS_SSH_DOCKER_{name}")).unwrap_or_else(|err| {
        panic!("STATGLASS_SSH_DOCKER_{name}: {err}. Run make ssh-docker-test")
    })
}

fn fixture() -> (Arc<RusshDialer>, ConformanceHost) {
    let key = fs::read(env("KEY")).expect("read the fixture's P-256 key");
    let signer = SoftwareSigner::from_pkcs8_der(&key).expect("decode the fixture's P-256 key");
    let host_key = env("HOST_KEY");
    let (algorithm, sha256) = host_key
        .split_once(' ')
        .expect("algorithm and SHA256 fingerprint");
    let bin = env("AGENT_BIN");
    let socket = env("SOCKET");
    let endpoint = Endpoint {
        targets: vec![Target {
            route: Route::Lan,
            host: env("HOST"),
        }],
        port: Some(env("PORT").parse().expect("sshd port")),
        user: Some(env("USER")),
        host_keys: vec![PinnedHostKey {
            algorithm: algorithm.into(),
            sha256: sha256.into(),
        }],
        command: RemoteCommand::Agent {
            bin: bin.clone(),
            system: false,
            socket: Some(socket.clone()),
        },
    };
    let stopped = Endpoint {
        command: RemoteCommand::Agent {
            bin,
            system: false,
            socket: Some(format!("{socket}.stopped")),
        },
        ..endpoint.clone()
    };
    let host_id = HostId(env("HOST_ID").parse().expect("agent's host UUID"));
    let dialer = Arc::new(RusshDialer::new(Arc::new(signer)));
    (
        dialer,
        ConformanceHost {
            endpoint,
            stopped,
            host_id,
        },
    )
}

#[tokio::test]
#[ignore = "requires the Linux agent and sshd fixture from make ssh-docker-test"]
async fn live_session() {
    let (dialer, host) = fixture();
    conformance::live_session(dialer.as_ref(), &host).await;
}

#[tokio::test]
#[ignore = "requires the Linux agent and sshd fixture from make ssh-docker-test"]
async fn agent_not_running() {
    let (dialer, host) = fixture();
    conformance::agent_not_running(dialer.as_ref(), &host).await;
}

#[tokio::test]
#[ignore = "requires the Linux agent and sshd fixture from make ssh-docker-test"]
async fn source_syncs_mirror() {
    let (dialer, host) = fixture();
    conformance::source_syncs_mirror(dialer, &host).await;
}
