//! Session failures as serialized by the shared IPC layer.
use statglass_engine::{Source, SourceSink};
use statglass_ipc::status::{RemoteState, connection_status};
use statglass_schema::{HostId, HostInfo, HostRecord, OsKind};
use statglass_session::{
    BoxFuture, DialFailure, DialedStream, Dialer, Endpoint, IncompatibleSide, RemoteError,
    RemoteSource, Result, Route, SourceOptions, Target,
};
use std::{sync::Arc, time::Duration};

fn remote_host() -> HostRecord {
    HostRecord {
        id: serde_json::from_str(r#""7f3a2c00-0000-4000-8000-000000000001""#)
            .expect("fixture contains a valid host id"),
        is_local: false,
        display_name: "studio".into(),
        info: HostInfo {
            os: OsKind::MacOs,
            os_version: "27.0".into(),
            model: None,
            chip: None,
            chip_known: true,
            cpu_topology: Vec::new(),
            mem_total_bytes: 0,
            boot_time_ms: 0,
            gpu_dvfs_mhz: Vec::new(),
            kernel: None,
            boot_mounts: Vec::new(),
        },
    }
}

struct FailingDialer(Option<IncompatibleSide>);

impl Dialer for FailingDialer {
    fn dial<'a>(&'a self, _: &'a Endpoint, _: &'a Target) -> BoxFuture<'a, Result<DialedStream>> {
        Box::pin(async move {
            Err(RemoteError::IncompatiblePeer {
                version: "test peer".into(),
                reason: "ranges do not overlap".into(),
                side: Some(self.0.expect("scripted dial panic")),
            })
        })
    }

    fn classify(&self, _: &DialFailure<'_>) -> RemoteError {
        panic!("test dial does not open a stream")
    }
}

#[tokio::test(start_paused = true)]
async fn terminal_session_failures_keep_their_kind_and_side_in_remote_connection() {
    for (side, kind, direction, message) in [
        (
            Some(IncompatibleSide::Host),
            "incompatible",
            Some("host"),
            "incompatible remote: ranges do not overlap",
        ),
        (
            Some(IncompatibleSide::App),
            "incompatible",
            Some("app"),
            "incompatible remote: ranges do not overlap",
        ),
        (
            None,
            "internal",
            None,
            "The remote session stopped unexpectedly",
        ),
    ] {
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let source = RemoteSource::with_options(
            remote_host(),
            HostId(Default::default()),
            Arc::new(FailingDialer(side)),
            Endpoint {
                targets: vec![Target {
                    route: Route::Lan,
                    host: "studio.local".into(),
                }],
                port: None,
                user: None,
                host_keys: Vec::new(),
                command: Default::default(),
            },
            Arc::new(move |status| {
                let _ = send.send(connection_status(&status));
            }),
            None,
            SourceOptions {
                runtime: Some(tokio::runtime::Handle::current()),
                probe: Some(Arc::new(|| statglass_session::network::LocalNetwork {
                    online: true,
                    lan_up: true,
                    tailscale_up: false,
                })),
            },
        );
        let _handle = source
            .start(SourceSink {
                live: Default::default(),
                store: None,
            })
            .unwrap();
        let connection = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let connection = receive.recv().await.unwrap();
                if connection.state == RemoteState::Error {
                    break connection;
                }
            }
        })
        .await
        .expect("source should publish a terminal error");
        let routes = if side.is_some() {
            serde_json::json!([{"route": "lan", "kind": "incompatible"}])
        } else {
            serde_json::json!([])
        };
        assert_eq!(
            serde_json::to_value(connection).unwrap(),
            serde_json::json!({
                "state": "error",
                "route": null,
                "sync": "idle",
                "failure": kind,
                "incompatible_side": direction,
                "message": message,
                "route_failures": routes,
            })
        );
    }
}
