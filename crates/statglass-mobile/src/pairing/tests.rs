use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use p256::ecdsa::SigningKey;
use serde_json::{Value, json};
use statglass_ipc::mobile::{
    DemandLevel, HandoverReasonInfo, HostDemand, MobileCall, MobileConfig, OfferedHost,
    UnavailableHostInfo,
};
use statglass_proto::handover::{HandoverReason, HostBundle, UnavailableHost, encode_bundle};
use statglass_proto::pairing::{
    BundleHost, BundleHostKey, BundleTarget, PAYLOAD_VERSION, PairReply, PairStart, encode_payload,
};
use statglass_schema::lock::LockExt;
use statglass_session::pairing::{read_pair_frame, write_pair_frame};
use statglass_session::{BoxFuture, DialFailure, DialedStream, ForcedToken, RemoteCommand, Target};
use statglass_ssh::SoftwareSigner;
use tokio::runtime::Handle;
use tokio::sync::{Notify, mpsc};
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
    status_changed: Notify,
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
        } else if event["kind"] == "remote_hosts_changed" {
            self.status_changed.notify_one();
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
    pending_key: Arc<AtomicBool>,
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
        if self.pending_key.load(Ordering::Relaxed) {
            return Box::pin(async { Err(RemoteError::Authentication("key refused".into())) });
        }
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
    pending_key: Arc<AtomicBool>,
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(RosterEvents {
            file: dir.path().join("hosts.json"),
            rosters: Mutex::default(),
            status_changed: Notify::new(),
        });
        let signer = Arc::new(NativeKey(Mutex::new(
            SoftwareSigner::generate().public_key().to_vec(),
        )));
        let sessions = Sessions::new(events.clone(), Some(signer.clone()));
        let (send, serving) = mpsc::unbounded_channel();
        let (record, endpoints) = mpsc::unbounded_channel();
        let pending_key = Arc::new(AtomicBool::new(false));
        sessions
            .start(
                Handle::current(),
                dir.path().into(),
                MobileConfig::default(),
                Arc::new(ServeDialer {
                    pipe: PeerDialer(send),
                    endpoints: record,
                    pending_key: pending_key.clone(),
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
            pending_key,
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

    fn reopen(&self, dialer: impl Dialer + 'static) -> Sessions {
        let reopened = Sessions::new(self.events.clone(), Some(self.signer.clone()));
        reopened
            .start(
                Handle::current(),
                self.dir.path().into(),
                MobileConfig::default(),
                Arc::new(dialer),
            )
            .unwrap();
        reopened
    }
}

async fn wait_for_connection(
    sessions: &Sessions,
    changed: &Notify,
    host: HostId,
    key: &str,
    value: &str,
) -> Value {
    timeout(WAIT, async {
        loop {
            let rows = sessions.call(MobileCall::ListRemoteHosts).await.unwrap();
            if let Some(row) = rows
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == json!(host) && row["connection"][key] == value)
            {
                return row.clone();
            }
            changed.notified().await;
        }
    })
    .await
    .unwrap()
}

async fn demand(sessions: &Sessions, host: HostId, level: DemandLevel) {
    sessions
        .call(MobileCall::SetDemand {
            demand: vec![HostDemand { host, level }],
        })
        .await
        .unwrap();
}

fn handed_host(n: u128, address: &str) -> BundleHost {
    let mut host = offer().host;
    host.host_id = HostId(format!("{n:032x}").parse().unwrap());
    host.name = address.into();
    host.targets[0].host = address.into();
    host.host_keys[0].sha256 = fingerprint(1);
    host
}

fn fingerprint(byte: u8) -> String {
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    format!("SHA256:{}", STANDARD_NO_PAD.encode([byte; 32]))
}

fn update(from: HostId, hosts: Vec<BundleHost>) -> String {
    update_at(from, hosts, 1_800_000_000_000)
}

fn update_at(from: HostId, hosts: Vec<BundleHost>, issued_ms: i64) -> String {
    encode_bundle(&HostBundle {
        version: 1,
        from,
        hosts,
        unavailable: vec![],
        issued_ms,
    })
}

#[tokio::test]
async fn handover_approval_lists_other_hosts_only_with_the_offer_capability() {
    for can_hand_over in [false, true] {
        let fixture = Fixture::new();
        let mut payload = offer();
        // The capability is independent of the label the controller gives its OS.
        payload.host.os = "linux".into();
        payload.can_hand_over = can_hand_over;
        let target = handed_host(2, "build.local");
        let unavailable = UnavailableHost {
            host_id: handed_host(3, "jump.local").host_id,
            name: "Jump host".into(),
            reason: HandoverReason::ProxyJump,
        };
        let (mut reply, main) = approved(&payload, "approved.tailnet");
        if let PairReply::Approved {
            hosts,
            unavailable: failures,
            ..
        } = &mut reply
        {
            hosts.push(target.clone());
            failures.push(unavailable.clone());
        }
        let paired = fixture
            .pair(&payload, "SHA256:offer", Some(reply))
            .await
            .unwrap();
        assert_eq!(
            paired.offered,
            if can_hand_over {
                vec![OfferedHost {
                    id: target.host_id,
                    name: "build.local".into(),
                    os: "macos".into(),
                    user: "pairing".into(),
                    port: Some(2200),
                    targets: vec![MobileTarget {
                        route: RemoteRoute::Lan,
                        host: "build.local".into(),
                    }],
                    host_keys: vec![MobileHostKey {
                        algorithm: "ssh-ed25519".into(),
                        sha256: fingerprint(1),
                    }],
                }]
            } else {
                vec![]
            }
        );
        assert_eq!(
            paired.unavailable,
            if can_hand_over {
                vec![UnavailableHostInfo {
                    id: unavailable.host_id,
                    name: "Jump host".into(),
                    reason: HandoverReasonInfo::ProxyJump,
                }]
            } else {
                vec![]
            }
        );
        // Pairing always persists only the host the user approved.
        fixture.expect_roster(&[main]).await;
    }
}

#[tokio::test]
async fn handover_apply_persists_selected_restricted_hosts_and_same_controller_changes() {
    let fixture = Fixture::new();
    let from = offer().host.host_id;
    let other_mac = handed_host(3, "other-controller.local").host_id;
    let removed = handed_host(4, "removed.local");
    let changed = handed_host(5, "changed.local");
    let untouched = handed_host(6, "untouched.local");
    let excluded = handed_host(7, "excluded.local");
    let another = handed_host(8, "other-mac-host.local");
    let latest = handed_host(9, "new.local");
    let (reply, _) = approved(&offer(), "direct.local");
    fixture
        .pair(&offer(), "SHA256:offer", Some(reply))
        .await
        .unwrap();

    for (controller, hosts, count) in [
        (
            from,
            vec![
                removed.clone(),
                changed.clone(),
                untouched.clone(),
                excluded.clone(),
            ],
            3,
        ),
        (other_mac, vec![another.clone()], 1),
    ] {
        let plan = handover::decode_bundle(&fixture.sessions, &update(controller, hosts)).unwrap();
        handover::add_handover_hosts(
            &fixture.sessions,
            plan.new.into_iter().take(count).collect(),
            Some(plan.preview_id),
        )
        .unwrap();
    }

    // Reopen the core and test through its command surface, using the persisted roster
    // and controller associations from the first run.
    let (dials, _serving) = mpsc::unbounded_channel();
    let (endpoints, mut observed) = mpsc::unbounded_channel();
    let reopened = fixture.reopen(ServeDialer {
        pipe: PeerDialer(dials),
        endpoints,
        pending_key: Arc::default(),
    });
    let mut new_endpoint = changed.clone();
    new_endpoint.name = "Renamed on Mac".into();
    new_endpoint.targets[0].host = "new-target.local".into();
    new_endpoint.host_keys[0].sha256 = fingerprint(2);
    let text = update(
        from,
        vec![new_endpoint.clone(), untouched.clone(), latest.clone()],
    );
    let before = fs::read(&fixture.events.file).unwrap();
    let plan = handover::decode_bundle(&reopened, &text).unwrap();
    assert_eq!(plan.from, from);
    assert_eq!(plan.new.len(), 1);
    assert_eq!(plan.new[0].id, latest.host_id);
    assert_eq!(plan.new[0].targets[0].host, "new.local");
    assert_eq!(plan.removed, [removed.host_id]);
    assert_eq!(plan.changed, [changed.host_id]);
    assert!(plan.unavailable.is_empty());
    assert_eq!(fs::read(&fixture.events.file).unwrap(), before);

    // A substituted or stale target cannot write a roster.
    let mut unapproved = plan.new[0].clone();
    unapproved.targets[0].host = "not-in-the-bundle.local".into();
    assert!(matches!(
        handover::add_handover_hosts(&reopened, vec![unapproved], Some(plan.preview_id)),
        Err(CommandError::Pairing {
            reason: statglass_ipc::error::PairingFailure::Invalid,
            ..
        })
    ));
    assert_eq!(fs::read(&fixture.events.file).unwrap(), before);
    handover::add_handover_hosts(&reopened, plan.new, Some(plan.preview_id)).unwrap();

    expect_handover_roster(
        &reopened,
        [
            (from, None, false),
            (removed.host_id, Some(from), true),
            (changed.host_id, Some(from), false),
            (untouched.host_id, Some(from), false),
            (another.host_id, Some(other_mac), false),
            (latest.host_id, Some(from), false),
        ],
    )
    .await;
    assert_eq!(
        handover::decode_bundle(&reopened, &text).unwrap().changed,
        []
    );
    demand(&reopened, changed.host_id, DemandLevel::Compact).await;
    let (endpoint, target) = timeout(WAIT, observed.recv()).await.unwrap().unwrap();
    assert_eq!(target.host, "new-target.local");
    assert_eq!(endpoint.host_keys[0].sha256, fingerprint(2));
    assert_eq!(
        endpoint.command,
        RemoteCommand::Restricted {
            forced: ForcedToken::Serve
        }
    );
}

async fn expect_handover_roster<const N: usize>(
    sessions: &Sessions,
    expected: [(HostId, Option<HostId>, bool); N],
) {
    let rows = sessions.call(MobileCall::ListRemoteHosts).await.unwrap();
    let actual: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["id"].clone(),
                row["source_mac"].clone(),
                row["removed_by_controller"].clone(),
            )
        })
        .collect();
    assert_eq!(
        actual,
        expected.map(|(id, mac, removed)| (json!(id), json!(mac), json!(removed)))
    );
}

#[tokio::test]
async fn handover_never_applies_a_replaced_preview_and_rejects_an_older_bundle_after_restart() {
    let fixture = Fixture::new();
    let from = offer().host.host_id;
    let host = handed_host(2, "build.local");
    let old = update_at(from, vec![host.clone()], 100);
    let older = handover::decode_bundle(&fixture.sessions, &old).unwrap();
    let latest =
        handover::decode_bundle(&fixture.sessions, &update_at(from, vec![host], 200)).unwrap();
    for id in [None, Some(older.preview_id)] {
        let error = handover::add_handover_hosts(&fixture.sessions, vec![], id).unwrap_err();
        assert!(matches!(
            error,
            CommandError::Pairing {
                reason: statglass_ipc::error::PairingFailure::Invalid,
                ..
            }
        ));
    }
    assert!(!fixture.events.file.exists());
    handover::add_handover_hosts(&fixture.sessions, latest.new, Some(latest.preview_id)).unwrap();
    let (dials, _serving) = mpsc::unbounded_channel();
    let reopened = fixture.reopen(PeerDialer(dials));
    let error = handover::decode_bundle(&reopened, &old).unwrap_err();
    let CommandError::Pairing {
        reason: statglass_ipc::error::PairingFailure::Invalid,
        message,
    } = error
    else {
        panic!("expected a typed invalid update");
    };
    assert!(message.contains("older than the last one from this Mac"));
}

#[tokio::test]
async fn handover_wrong_code_types_and_missing_pins_are_typed_invalid() {
    let fixture = Fixture::new();
    let payload = offer();
    let mut host = handed_host(2, "build.local");
    let valid_update = update(payload.host.host_id, vec![host.clone()]);
    host.host_keys[0].sha256 = "SHA256:bad".into();
    let malformed_pin = update(payload.host.host_id, vec![host.clone()]);
    host.host_keys.clear();
    let invalid_update = update(payload.host.host_id, vec![host]);
    for bad in [encode_payload(&payload), invalid_update, malformed_pin] {
        assert!(matches!(
            handover::decode_bundle(&fixture.sessions, &bad),
            Err(CommandError::Pairing {
                reason: statglass_ipc::error::PairingFailure::Invalid,
                ..
            })
        ));
    }
    assert!(matches!(
        preview(&valid_update, wall_ms()),
        Err(CommandError::Pairing {
            reason: statglass_ipc::error::PairingFailure::Invalid,
            ..
        })
    ));
    assert!(!fixture.events.file.exists());
}

#[tokio::test]
async fn handover_pending_key_is_refused_until_retry_after_install() {
    let mut fixture = Fixture::new();
    let target = handed_host(2, "build.local");
    let payload = PairingPayload {
        can_hand_over: true,
        ..offer()
    };
    let (mut reply, _) = approved(&payload, "direct.local");
    if let PairReply::Approved { hosts, .. } = &mut reply {
        hosts.push(target.clone());
    }
    let approval = fixture
        .pair(&payload, "SHA256:offer", Some(reply))
        .await
        .unwrap();
    fixture.pending_key.store(true, Ordering::Relaxed);
    handover::add_handover_hosts(&fixture.sessions, approval.offered, None).unwrap();
    demand(&fixture.sessions, target.host_id, DemandLevel::Compact).await;
    let sessions = &fixture.sessions;
    let changed = &fixture.events.status_changed;
    let failure = wait_for_connection(
        sessions,
        changed,
        target.host_id,
        "failure",
        "authentication",
    )
    .await;
    assert!(failure["last_seen_ms"].is_null());
    assert_eq!(failure["source_mac"], json!(payload.host.host_id));
    let (endpoint, route) = fixture.endpoints.try_recv().unwrap();
    assert_eq!(
        endpoint.command,
        RemoteCommand::Restricted {
            forced: ForcedToken::Serve
        }
    );
    assert_eq!(endpoint.host_keys[0].sha256, target.host_keys[0].sha256);
    assert_eq!(route.host, target.targets[0].host);
    fixture.pending_key.store(false, Ordering::Relaxed);
    fixture
        .sessions
        .call(MobileCall::RetryRemoteHost {
            host: target.host_id,
        })
        .await
        .unwrap();
    let mut dial = timeout(WAIT, fixture.serving.recv())
        .await
        .unwrap()
        .unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(&fixture.events.file).unwrap()).unwrap();
    dial.handshake(&serde_json::from_value(saved["hosts"][1].clone()).unwrap())
        .await;
    assert_eq!(
        wait_for_connection(sessions, changed, target.host_id, "state", "connected").await["connection"]
            ["route"],
        "lan"
    );
    let removed =
        handover::decode_bundle(&fixture.sessions, &update(payload.host.host_id, vec![])).unwrap();
    assert_eq!(removed.removed, [target.host_id]);
    handover::add_handover_hosts(&fixture.sessions, vec![], Some(removed.preview_id)).unwrap();
    demand(&fixture.sessions, target.host_id, DemandLevel::Full).await;
    timeout(WAIT, async {
        loop {
            if let statglass_proto::Message::Interest(interest) = dial.read().await
                && interest.detail
            {
                break;
            }
        }
    })
    .await
    .unwrap();
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
