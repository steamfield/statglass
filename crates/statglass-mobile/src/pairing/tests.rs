use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use p256::ecdsa::SigningKey;
use serde_json::{Value, json};
use statglass_ipc::mobile::{DemandLevel, HostDemand, MobileCall, MobileConfig};
use statglass_proto::pairing::{
    BundleHost, BundleHostKey, BundleTarget, PAYLOAD_VERSION, PairReply, PairStart, encode_payload,
};
use statglass_schema::lock::LockExt;
use statglass_session::pairing::{read_pair_frame, write_pair_frame};
use statglass_session::{BoxFuture, DialFailure, DialedStream, ForcedToken, RemoteCommand, Target};
use statglass_ssh::SoftwareSigner;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::*;
use crate::ffi::{CoreEvents, NativeSigner, NativeSignerError};
use crate::sessions::tests::{Dial, PeerDialer};

const WAIT: Duration = Duration::from_secs(5);
const DEVICE: &str = "Work phone";
const MODEL: &str = "iPhone 17";

struct NativeKey(Mutex<Vec<u8>>);

impl NativeSigner for NativeKey {
    fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
        Ok(self.0.lock_ok().clone())
    }

    fn sign(&self, _: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
        panic!("the fake session does not request a signature");
    }
}

struct RosterEvents {
    file: PathBuf,
    rosters: Mutex<Vec<(Value, Option<Vec<u8>>)>>,
}

impl CoreEvents for RosterEvents {
    fn live(&self, _: u32, _: String) -> bool {
        false
    }

    fn event(&self, event: String) {
        let event: Value = serde_json::from_str(&event).unwrap();
        if event["kind"] == "hosts_changed" {
            self.rosters
                .lock_ok()
                .push((event["hosts"].clone(), fs::read(&self.file).ok()));
        }
    }
}

struct PairDialer {
    pipe: PeerDialer,
    signer: Arc<dyn Signer>,
    public_key: p256::Sec1Point,
    offered: BundleHost,
    actual_pin: &'static str,
}

struct ServeDialer {
    pipe: PeerDialer,
    endpoints: mpsc::UnboundedSender<(Endpoint, Target)>,
}

impl Dialer for ServeDialer {
    fn dial<'a>(
        &'a self,
        endpoint: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, statglass_session::Result<DialedStream>> {
        self.endpoints
            .send((endpoint.clone(), target.clone()))
            .expect("test observes serving endpoint");
        self.pipe.dial(endpoint, target)
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        self.pipe.classify(failure)
    }
}

impl Dialer for PairDialer {
    fn dial<'a>(
        &'a self,
        endpoint: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, statglass_session::Result<DialedStream>> {
        Box::pin(async move {
            assert_eq!(
                self.signer.public_key().await.unwrap(),
                self.public_key.as_bytes()
            );
            assert_eq!(
                endpoint.command,
                RemoteCommand::Restricted {
                    forced: ForcedToken::Pair
                }
            );
            assert_eq!(endpoint.user.as_deref(), Some(self.offered.user.as_str()));
            assert_eq!(endpoint.port, self.offered.port);
            assert_eq!(target.host, self.offered.targets[0].host);
            assert_eq!(
                endpoint.host_keys[0].sha256,
                self.offered.host_keys[0].sha256
            );
            if endpoint.host_keys[0].sha256 != self.actual_pin {
                return Err(RemoteError::HostKey(
                    "SSH peer key did not match the offer".into(),
                ));
            }
            self.pipe.dial(endpoint, target).await
        })
    }

    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
        self.pipe.classify(failure)
    }
}

struct Fixture {
    events: Arc<RosterEvents>,
    sessions: Sessions,
    signer: Arc<NativeKey>,
    serving: mpsc::UnboundedReceiver<Dial>,
    endpoints: mpsc::UnboundedReceiver<(Endpoint, Target)>,
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(RosterEvents {
            file: dir.path().join("hosts.json"),
            rosters: Mutex::default(),
        });
        let signer = Arc::new(NativeKey(Mutex::new(
            SoftwareSigner::generate().public_key().to_vec(),
        )));
        let sessions = Sessions::new(events.clone(), Some(signer.clone()));
        let (send, serving) = mpsc::unbounded_channel();
        let (record, endpoints) = mpsc::unbounded_channel();
        sessions
            .start(
                Handle::current(),
                dir.path().into(),
                MobileConfig::default(),
                Arc::new(ServeDialer {
                    pipe: PeerDialer(send),
                    endpoints: record,
                }),
            )
            .unwrap();
        events.rosters.lock_ok().clear();
        Self {
            events,
            sessions,
            signer,
            serving,
            endpoints,
            dir,
        }
    }

    async fn pair(
        &self,
        payload: &PairingPayload,
        actual_pin: &'static str,
        reply: Option<PairReply>,
    ) -> Result<PairedHost, CommandError> {
        let (send, mut pairing) = mpsc::unbounded_channel();
        let device_key = self.signer.public_key().unwrap();
        let pairing_key = SigningKey::from_slice(&payload.pairing_key).unwrap();
        let text = encode_payload(payload);
        let request = pair_with_dialer(
            &self.sessions,
            device_key.clone(),
            &text,
            DEVICE,
            MODEL,
            |signer| PairDialer {
                pipe: PeerDialer(send),
                signer,
                public_key: pairing_key.verifying_key().to_sec1_point(false),
                offered: payload.host.clone(),
                actual_pin,
            },
        );
        let host = async {
            if let Some(reply) = reply {
                let mut dial = pairing.recv().await.unwrap();
                assert_eq!(
                    read_pair_frame::<PairStart>(&mut dial.peer).await.unwrap(),
                    PairStart {
                        nonce: payload.nonce.clone(),
                        device_key,
                        device_name: DEVICE.into(),
                        model: MODEL.into(),
                    }
                );
                write_pair_frame(&mut dial.peer, &PairReply::Waiting)
                    .await
                    .unwrap();
                write_pair_frame(&mut dial.peer, &reply).await.unwrap();
            }
        };
        let (result, ()) = timeout(WAIT, async { tokio::join!(request, host) })
            .await
            .unwrap();
        if result.is_err() {
            assert!(pairing.try_recv().is_err());
        }
        result
    }

    async fn expect_roster(&self, hosts: &[MobileHost]) {
        let result = self.sessions.call(MobileCall::ListHosts).await.unwrap();
        let rows = result.as_array().unwrap();
        assert_eq!(rows.len(), hosts.len());
        for (record, host) in rows.iter().zip(hosts) {
            assert_eq!(record["id"], json!(host.id));
            assert_eq!(record["display_name"], json!(host.name));
        }
    }

    async fn next_session(&mut self, target: &str) -> Dial {
        // A host dials only once a screen demands it; the hosts list demands its rows.
        let rows = self.sessions.call(MobileCall::ListHosts).await.unwrap();
        let demand = rows
            .as_array()
            .unwrap()
            .iter()
            .map(|row| HostDemand {
                host: serde_json::from_value(row["id"].clone()).unwrap(),
                level: DemandLevel::Full,
            })
            .collect();
        self.sessions
            .call(MobileCall::SetDemand { demand })
            .await
            .unwrap();
        let dial = timeout(WAIT, self.serving.recv()).await.unwrap().unwrap();
        assert_eq!(dial.target, target);
        dial
    }
}

fn offer() -> PairingPayload {
    PairingPayload {
        version: PAYLOAD_VERSION,
        pairing_key: [7; 32],
        nonce: "55bb3aa9cf3c45d7df0b70dd41999f43".into(),
        code: "AAA222".into(),
        expires_ms: wall_ms() + 60_000,
        can_hand_over: false,
        host: BundleHost {
            host_id: HostId("00000000-0000-0000-0000-000000000001".parse().unwrap()),
            name: "Studio".into(),
            os: "macos".into(),
            user: "pairing".into(),
            port: Some(2200),
            targets: vec![BundleTarget {
                route: BundleRoute::Lan,
                host: "offer.local".into(),
            }],
            host_keys: vec![BundleHostKey {
                algorithm: "ssh-ed25519".into(),
                sha256: "SHA256:offer".into(),
            }],
        },
    }
}

fn approved(payload: &PairingPayload, address: &str) -> (PairReply, MobileHost) {
    let mut approved = payload.host.clone();
    approved.user = "monitor".into();
    approved.port = Some(2250);
    approved.targets[0].host = address.into();
    approved.targets[0].route = BundleRoute::Tailscale;
    approved.host_keys[0].sha256 = "SHA256:approved".into();
    let saved = MobileHost {
        id: approved.host_id,
        name: approved.name.clone(),
        user: approved.user.clone(),
        port: approved.port,
        targets: vec![MobileTarget {
            route: RemoteRoute::Tailscale,
            host: address.into(),
        }],
        host_keys: vec![MobileHostKey {
            algorithm: "ssh-ed25519".into(),
            sha256: "SHA256:approved".into(),
        }],
        removed_by_controller: false,
        command: MobileCommand::Restricted,
    };
    (
        PairReply::Approved {
            device: "7F3A2C".into(),
            hosts: vec![approved],
            unavailable: Vec::new(),
        },
        saved,
    )
}

#[tokio::test]
async fn approval_uses_the_ephemeral_key_then_starts_and_persists_the_restricted_host() {
    let mut fixture = Fixture::new();
    let payload = offer();
    let (answer, host) = approved(&payload, "approved.tailnet");
    assert_eq!(
        fixture
            .pair(&payload, "SHA256:offer", Some(answer))
            .await
            .unwrap(),
        PairedHost {
            id: host.id,
            name: host.name.clone(),
            offered: Vec::new(),
            unavailable: Vec::new(),
        }
    );
    let mut session = fixture.next_session("approved.tailnet").await;
    let (endpoint, target) = fixture.endpoints.try_recv().unwrap();
    assert_eq!(
        target,
        Target {
            route: Route::Tailscale,
            host: "approved.tailnet".into()
        }
    );
    assert_eq!(
        endpoint.command,
        RemoteCommand::Restricted {
            forced: ForcedToken::Serve
        }
    );
    assert_eq!(endpoint.port, Some(2250));
    assert_eq!(endpoint.user.as_deref(), Some("monitor"));
    assert_eq!(
        endpoint.host_keys,
        [statglass_session::PinnedHostKey {
            algorithm: "ssh-ed25519".into(),
            sha256: "SHA256:approved".into()
        }]
    );
    session.handshake(&host).await;
    fixture.expect_roster(std::slice::from_ref(&host)).await;
    {
        let events = fixture.events.rosters.lock_ok();
        assert_eq!(events[0].0[0]["id"], json!(host.id));
        let saved: Value = serde_json::from_slice(
            events[0]
                .1
                .as_deref()
                .expect("roster was saved before the event"),
        )
        .unwrap();
        assert_eq!(
            saved,
            json!({"device_key": STANDARD.encode(fixture.signer.public_key().unwrap()), "hosts": [&host]})
        );
    }

    let reopened = Sessions::new(fixture.events.clone(), Some(fixture.signer.clone()));
    let (send, mut dials) = mpsc::unbounded_channel();
    reopened
        .start(
            Handle::current(),
            fixture.dir.path().into(),
            MobileConfig::default(),
            Arc::new(PeerDialer(send)),
        )
        .unwrap();
    reopened
        .call(MobileCall::SetDemand {
            demand: vec![HostDemand {
                host: host.id,
                level: DemandLevel::Compact,
            }],
        })
        .await
        .unwrap();
    let mut dial = timeout(WAIT, dials.recv()).await.unwrap().unwrap();
    assert_eq!(dial.target, "approved.tailnet");
    dial.handshake(&host).await;
}

#[tokio::test]
async fn refusals_and_rejected_host_keys_never_add_or_persist_a_host() {
    let fixture = Fixture::new();
    let payload = offer();
    for (reply, reason) in [
        (PairReply::Denied, "denied"),
        (PairReply::Expired, "expired"),
        (
            PairReply::Error {
                error: PairError::Used,
            },
            "used",
        ),
        (
            PairReply::Error {
                error: PairError::Unknown,
            },
            "unknown",
        ),
        (
            PairReply::Error {
                error: PairError::Unavailable,
            },
            "unavailable",
        ),
    ] {
        let error = fixture
            .pair(&payload, "SHA256:offer", Some(reply))
            .await
            .unwrap_err();
        let error = serde_json::to_value(error).unwrap();
        assert_eq!(error["kind"], "pairing");
        assert_eq!(error["reason"], reason);
        assert!(!fixture.events.file.exists());
    }
    let error = fixture
        .pair(&payload, "SHA256:different-peer", None)
        .await
        .unwrap_err();
    assert!(matches!(error, CommandError::HostKeyUnknown { .. }));
    assert!(!fixture.events.file.exists());
    fixture.expect_roster(&[]).await;
    assert!(fixture.events.rosters.lock_ok().is_empty());
}

#[tokio::test]
async fn pairing_the_phones_own_id_fails_without_dialing() {
    let fixture = Fixture::new();
    let mut payload = offer();
    payload.host.host_id = fixture.sessions.phone_id().unwrap();
    for scalar in [[7; 32], [0; 32]] {
        payload.pairing_key = scalar;
        let text = encode_payload(&payload);
        let (send, mut dials) = mpsc::unbounded_channel();
        let result = pair_with_dialer(
            &fixture.sessions,
            fixture.signer.public_key().unwrap(),
            &text,
            DEVICE,
            MODEL,
            |_| PeerDialer(send),
        )
        .await;
        assert!(matches!(result, Err(CommandError::RemoteIdentity { .. })));
        assert!(dials.try_recv().is_err());
    }
    assert!(!fixture.events.file.exists());
    fixture.expect_roster(&[]).await;
}

#[tokio::test]
async fn repairing_replaces_the_endpoint_and_key_without_renaming_the_host() {
    let mut fixture = Fixture::new();
    let mut payload = offer();
    let (reply, first) = approved(&payload, "first.tailnet");
    fixture
        .pair(&payload, "SHA256:offer", Some(reply))
        .await
        .unwrap();
    let mut first_dial = fixture.next_session("first.tailnet").await;
    first_dial.handshake(&first).await;

    let replacement_key = SoftwareSigner::generate().public_key().to_vec();
    *fixture.signer.0.lock_ok() = replacement_key.clone();
    assert!(state(&fixture.sessions).key_changed);
    payload.host.name = "Different offer name".into();
    let (reply, mut expected) = approved(&payload, "replacement.tailnet");
    let paired = fixture
        .pair(&payload, "SHA256:offer", Some(reply))
        .await
        .unwrap();
    expected.name.clone_from(&first.name);
    assert_eq!(
        paired,
        PairedHost {
            id: expected.id,
            name: first.name,
            offered: Vec::new(),
            unavailable: Vec::new(),
        }
    );
    timeout(WAIT, first_dial.closing).await.unwrap().unwrap();
    first_dial.finish_close.send(()).unwrap();
    fixture
        .next_session("replacement.tailnet")
        .await
        .handshake(&expected)
        .await;
    fixture.expect_roster(std::slice::from_ref(&expected)).await;
    let saved: Value = serde_json::from_slice(&fs::read(&fixture.events.file).unwrap()).unwrap();
    assert_eq!(
        saved,
        json!({"device_key": STANDARD.encode(replacement_key), "hosts": [&expected]})
    );
    assert!(!state(&fixture.sessions).key_changed);
}

#[tokio::test]
async fn a_failed_save_never_publishes_or_starts_the_approved_host() {
    let mut fixture = Fixture::new();
    let payload = offer();
    let (reply, _) = approved(&payload, "approved.tailnet");
    fs::create_dir(&fixture.events.file).unwrap();
    let file_names = || {
        let mut names: Vec<_> = fs::read_dir(fixture.dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        names
    };
    let before = file_names();
    let failure = fixture
        .pair(&payload, "SHA256:offer", Some(reply))
        .await
        .unwrap_err();
    assert!(matches!(failure, CommandError::Store { .. }));
    fixture.expect_roster(&[]).await;
    assert!(fixture.events.rosters.lock_ok().is_empty());
    assert!(fixture.serving.try_recv().is_err());
    assert_eq!(file_names(), before);
}

#[tokio::test]
async fn a_failed_repair_save_leaves_the_previous_session_available() {
    let mut fixture = Fixture::new();
    let payload = offer();
    let (reply, host) = approved(&payload, "first.tailnet");
    fixture
        .pair(&payload, "SHA256:offer", Some(reply))
        .await
        .unwrap();
    let mut first = fixture.next_session("first.tailnet").await;
    first.handshake(&host).await;
    fixture.events.rosters.lock_ok().clear();

    // Force persist to fail without altering the prior saved roster.
    let prior = fs::read(&fixture.events.file).unwrap();
    let backup = fixture.dir.path().join("prior-hosts.json");
    fs::rename(&fixture.events.file, &backup).unwrap();
    fs::create_dir(&fixture.events.file).unwrap();
    let (reply, _) = approved(&payload, "replacement.tailnet");
    let error = fixture
        .pair(&payload, "SHA256:offer", Some(reply))
        .await
        .unwrap_err();
    assert!(matches!(error, CommandError::Store { .. }));
    fs::remove_dir(&fixture.events.file).unwrap();
    fs::rename(backup, &fixture.events.file).unwrap();

    fixture.expect_roster(&[host]).await;
    assert_eq!(fs::read(&fixture.events.file).unwrap(), prior);
    assert!(fixture.events.rosters.lock_ok().is_empty());
    assert!(matches!(
        first.closing.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    assert!(fixture.serving.try_recv().is_err());
}

#[tokio::test]
async fn repairing_the_same_endpoint_reopens_its_session() {
    let mut fixture = Fixture::new();
    let payload = offer();
    let (reply, host) = approved(&payload, "approved.tailnet");
    fixture
        .pair(&payload, "SHA256:offer", Some(reply.clone()))
        .await
        .unwrap();
    let mut first = fixture.next_session("approved.tailnet").await;
    first.handshake(&host).await;
    fixture
        .pair(&payload, "SHA256:offer", Some(reply))
        .await
        .unwrap();
    timeout(WAIT, first.closing).await.unwrap().unwrap();
    first.finish_close.send(()).unwrap();
    fixture
        .next_session("approved.tailnet")
        .await
        .handshake(&host)
        .await;
    fixture.expect_roster(&[host]).await;
}
