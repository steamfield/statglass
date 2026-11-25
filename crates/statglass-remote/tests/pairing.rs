use p256::elliptic_curve::sec1::ToSec1Point;
use statglass_proto::pairing::{BundleHost, CODE_ALPHABET, PairError, PairReply, PairStart};
use statglass_remote::{
    ControlRequest, ControlResponse, DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public,
    PairCommands, PairedDevice, PairingError, PairingHost, bind_private,
    pairing::run_forced_for_nonce, run_forced,
};
use statglass_schema::HostId;
use statglass_schema::lock::LockExt;
use statglass_session::pairing::{read_pair_frame, write_pair_frame};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};
use tokio::net::{UnixListener, UnixStream};

const NOW: i64 = 1_800_000_000_000;
const NONCE: &str = "1cdd0c2c3aa881dad8a557c28b983f0a";

#[derive(Debug, PartialEq)]
enum Edit {
    Offer(EcdsaP256Public, String, i64, String),
    Device(EcdsaP256Public, String, String),
    Remove(String),
}

#[derive(Default)]
struct Keys {
    edits: Mutex<Vec<Edit>>,
    fail_removal: AtomicBool,
}

impl DeviceKeys for Keys {
    fn list_devices(&self) -> Result<Vec<PairedDevice>, DeviceKeysError> {
        unreachable!()
    }

    fn add_device(
        &self,
        key: &EcdsaP256Public,
        name: &str,
        command: &str,
    ) -> Result<DeviceTag, DeviceKeysError> {
        self.edits
            .lock_ok()
            .push(Edit::Device(key.clone(), name.into(), command.into()));
        Ok(DeviceTag::from_key(key))
    }

    fn revoke(&self, _tag: DeviceTag) -> Result<bool, DeviceKeysError> {
        unreachable!()
    }

    fn add_pairing(
        &self,
        key: &EcdsaP256Public,
        nonce: &str,
        expires_ms: i64,
        command: &str,
    ) -> Result<(), DeviceKeysError> {
        self.edits.lock_ok().push(Edit::Offer(
            key.clone(),
            nonce.into(),
            expires_ms,
            command.into(),
        ));
        Ok(())
    }

    fn remove_pairing(&self, nonce: &str) -> Result<bool, DeviceKeysError> {
        if self.fail_removal.load(Ordering::Relaxed) {
            return Err(DeviceKeysError::Io(std::io::Error::other(
                "temporary edit failure",
            )));
        }
        self.edits.lock_ok().push(Edit::Remove(nonce.into()));
        Ok(true)
    }
}

fn host() -> BundleHost {
    BundleHost {
        host_id: HostId(uuid::Uuid::from_u128(7)),
        name: "office".into(),
        os: "linux".into(),
        user: "me".into(),
        port: None,
        targets: vec![],
        host_keys: vec![],
    }
}

fn pairing() -> (PairingHost, Arc<Keys>) {
    let keys = Arc::new(Keys::default());
    let pairing = PairingHost::new(
        keys.clone(),
        PairCommands {
            pair: "/agent pair".into(),
            restricted: "/agent restricted --system".into(),
        },
    );
    (pairing, keys)
}

fn public(secret: &[u8; 32]) -> EcdsaP256Public {
    let public = p256::SecretKey::from_slice(secret)
        .expect("valid P-256 scalar")
        .public_key();
    EcdsaP256Public(
        public
            .to_sec1_point(false)
            .as_bytes()
            .try_into()
            .expect("65-byte uncompressed P-256 key"),
    )
}

fn start(nonce: &str, scalar: u8) -> PairStart {
    PairStart {
        nonce: nonce.into(),
        device_key: public(&[scalar; 32]).0.into(),
        device_name: "My iPhone".into(),
        model: "iPhone 17".into(),
    }
}

#[test]
fn pairing_offer_installs_the_matching_key_and_utc_deadline() {
    let (pairing, keys) = pairing();
    let offer = pairing.offer(host(), Duration::ZERO, NOW).unwrap();
    assert_eq!(offer.expires_ms, NOW + 600_000);
    assert_eq!(offer.nonce.len(), 32);
    assert!(offer.nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(offer.code.len(), 6);
    assert!(
        offer
            .code
            .chars()
            .all(|letter| CODE_ALPHABET.contains(letter))
    );
    assert_eq!(
        *keys.edits.lock().unwrap(),
        [Edit::Offer(
            public(&offer.pairing_key),
            offer.nonce.clone(),
            offer.expires_ms,
            format!("/agent pair --nonce {}", offer.nonce)
        )]
    );
    assert_eq!(pairing.status(&offer.nonce, NOW), PairReply::Waiting);
    assert_eq!(pairing.pending(&offer.nonce, NOW), PairReply::Waiting);
    assert!(matches!(
        pairing.approve(&offer.nonce, NOW),
        Err(PairingError::Pair(PairError::Invalid))
    ));
}

#[test]
fn pairing_waits_for_approval_and_installs_device_before_removing_the_pairing_key() {
    let (pairing, keys) = pairing();
    let offer = pairing.offer(host(), Duration::from_secs(60), NOW).unwrap();
    let request = start(&offer.nonce, 2);
    assert_eq!(pairing.start(&request, NOW + 10), PairReply::Waiting);
    assert_eq!(
        pairing.pending(&offer.nonce, NOW + 50),
        PairReply::Pending {
            device_name: request.device_name.clone(),
            model: request.model.clone(),
            code: offer.code
        }
    );
    assert_eq!(
        pairing.status(&offer.nonce, NOW + 59_999),
        PairReply::Waiting
    );
    assert_eq!(keys.edits.lock().unwrap().len(), 1);

    let key = public(&[2; 32]);
    let tag = DeviceTag::from_key(&key);
    let approved = PairReply::Approved {
        device: tag.to_string(),
        hosts: vec![host()],
    };
    assert_eq!(
        pairing.approve(&offer.nonce, NOW + 59_999).unwrap(),
        approved
    );
    assert_eq!(pairing.status(&offer.nonce, NOW + 60_000), approved);
    assert_eq!(
        keys.edits.lock().unwrap()[1..],
        [
            Edit::Device(
                key,
                request.device_name,
                format!("/agent restricted --system --device {tag}")
            ),
            Edit::Remove(offer.nonce)
        ]
    );
}

#[test]
fn pairing_denial_cancel_and_expiry_remove_only_the_one_time_key() {
    let (pairing, keys) = pairing();
    for (index, terminal) in [PairReply::Denied, PairReply::Expired, PairReply::Denied]
        .into_iter()
        .enumerate()
    {
        let offer = pairing.offer(host(), Duration::from_secs(1), NOW).unwrap();
        assert_eq!(
            pairing.start(&start(&offer.nonce, 3), NOW),
            PairReply::Waiting
        );
        let expired = terminal == PairReply::Expired;
        if expired {
            assert_eq!(pairing.status(&offer.nonce, NOW + 999), PairReply::Waiting);
            pairing.expire(NOW + 1000);
        } else if index == 0 {
            pairing.deny(&offer.nonce).unwrap();
        } else {
            pairing.cancel(&offer.nonce).unwrap();
        }
        assert_eq!(pairing.status(&offer.nonce, NOW + 1000), terminal);
        assert_eq!(pairing.approve(&offer.nonce, NOW + 1000).unwrap(), terminal);
        let edits = keys.edits.lock().unwrap();
        assert_eq!(edits.last(), Some(&Edit::Remove(offer.nonce)));
        assert!(!edits.iter().any(|edit| matches!(edit, Edit::Device(..))));
    }
}

#[test]
fn pairing_rejects_a_second_start_before_and_after_approval_and_unknown_or_invalid_starts() {
    let (pairing, _) = pairing();
    let offer = pairing.offer(host(), Duration::from_secs(60), NOW).unwrap();
    let same = start(&offer.nonce, 4);
    let different = start(&offer.nonce, 5);
    let mut invalid = same.clone();
    invalid.device_key.fill(0);
    assert_eq!(
        pairing.start(&invalid, NOW),
        PairReply::Error {
            error: PairError::Invalid
        }
    );
    assert_eq!(
        pairing.start(&start(NONCE, 4), NOW),
        PairReply::Error {
            error: PairError::Unknown
        }
    );
    assert_eq!(pairing.start(&same, NOW), PairReply::Waiting);
    for later in [&same, &different] {
        assert_eq!(
            pairing.start(later, NOW),
            PairReply::Error {
                error: PairError::Used
            }
        );
    }
    pairing.approve(&offer.nonce, NOW).unwrap();
    for later in [&same, &different] {
        assert_eq!(
            pairing.start(later, NOW),
            PairReply::Error {
                error: PairError::Used
            }
        );
    }
    let untouched = pairing.offer(host(), Duration::from_secs(1), NOW).unwrap();
    assert_eq!(
        pairing.start(&start(&untouched.nonce, 6), NOW + 1000),
        PairReply::Expired
    );
}

#[test]
fn pairing_retries_cleanup_before_reporting_approval_without_installing_twice() {
    let (pairing, keys) = pairing();
    let offer = pairing.offer(host(), Duration::from_secs(60), NOW).unwrap();
    assert_eq!(
        pairing.start(&start(&offer.nonce, 5), NOW),
        PairReply::Waiting
    );
    keys.fail_removal.store(true, Ordering::Relaxed);
    assert!(matches!(
        pairing.approve(&offer.nonce, NOW),
        Err(PairingError::Keys(_))
    ));
    assert_eq!(pairing.status(&offer.nonce, NOW), PairReply::Waiting);
    keys.fail_removal.store(false, Ordering::Relaxed);
    assert!(matches!(
        pairing.status(&offer.nonce, NOW),
        PairReply::Approved { .. }
    ));
    assert!(matches!(
        &keys.edits.lock().unwrap()[1..],
        [Edit::Device(..), Edit::Remove(..)]
    ));
}

#[test]
fn pairing_key_cannot_be_registered_as_the_permanent_device_key() {
    let (pairing, keys) = pairing();
    let offer = pairing.offer(host(), Duration::from_secs(60), NOW).unwrap();
    let mut request = start(&offer.nonce, 9);
    request.device_key = public(&offer.pairing_key).0.into();
    assert_eq!(
        pairing.start(&request, NOW),
        PairReply::Error {
            error: PairError::Invalid
        }
    );
    assert_eq!(pairing.pending(&offer.nonce, NOW), PairReply::Waiting);
    assert_eq!(keys.edits.lock_ok().len(), 1);
}

async fn request(listener: &UnixListener) -> (UnixStream, ControlRequest) {
    let (mut stream, _) = listener
        .accept()
        .await
        .expect("accept the forwarded control request");
    let size = stream
        .read_u32()
        .await
        .expect("read the control request length") as usize;
    let mut body = vec![0; size];
    stream
        .read_exact(&mut body)
        .await
        .expect("read the control request body");
    (
        stream,
        serde_json::from_slice(&body).expect("decode the control request"),
    )
}

async fn respond(mut stream: UnixStream, pairing: PairReply) {
    let reply = ControlResponse {
        pairing: Some(pairing),
        ok: true,
        message: String::new(),
        host: None,
        allow_remote_monitoring: None,
        show_menu_bar_icon: None,
        launch_at_login: None,
        updates: None,
    };
    let body = serde_json::to_vec(&reply).expect("encode the control reply");
    stream
        .write_u32(body.len() as u32)
        .await
        .expect("write the control reply length");
    stream
        .write_all(&body)
        .await
        .expect("write the control reply body");
}

#[tokio::test(start_paused = true)]
async fn pairing_forced_recovers_when_the_host_accepted_start_but_its_reply_timed_out() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let (pairing, _) = pairing();
    let offer = pairing.offer(host(), Duration::from_secs(60), NOW).unwrap();
    let start = start(&offer.nonce, 7);
    let (client, relay) = duplex(2048);
    let (stdin, stdout) = tokio::io::split(relay);
    let (mut reader, mut writer) = tokio::io::split(client);
    let server = async {
        let (
            lost,
            ControlRequest::PairStart {
                start: first,
                attempt,
            },
        ) = request(&listener).await
        else {
            panic!("expected first start")
        };
        assert_eq!(
            pairing.start_attempt(&first, attempt, NOW),
            PairReply::Waiting
        );
        let (
            stream,
            ControlRequest::PairStart {
                start: retry,
                attempt: retried_attempt,
            },
        ) = request(&listener).await
        else {
            panic!("expected retried start")
        };
        assert_eq!(retry, first);
        assert_eq!(retried_attempt, attempt);
        let mut different_attempt = attempt;
        different_attempt[0] ^= 1;
        assert_eq!(
            pairing.start_attempt(&retry, different_attempt, NOW),
            PairReply::Error {
                error: PairError::Used
            }
        );
        let reply = pairing.start_attempt(&retry, retried_attempt, NOW);
        let waiting = reply == PairReply::Waiting;
        respond(stream, reply).await;
        drop(lost);
        if waiting {
            let (status, ControlRequest::PairStatus { nonce }) = request(&listener).await else {
                panic!("expected status poll")
            };
            let approved = pairing.approve(&nonce, NOW).unwrap();
            assert_eq!(pairing.start_attempt(&retry, attempt, NOW), approved);
            assert_eq!(
                pairing.start_attempt(&retry, different_attempt, NOW),
                PairReply::Error {
                    error: PairError::Used
                }
            );
            respond(status, approved).await;
        }
    };
    write_pair_frame(&mut writer, &start).await.unwrap();
    let (exit, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(run_forced(stdin, stdout, &socket), server)
    })
    .await
    .unwrap();
    assert_eq!(
        read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
        PairReply::Waiting
    );
    assert!(matches!(
        read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
        PairReply::Approved { .. }
    ));
    assert_eq!(exit, 0);
}

#[tokio::test(start_paused = true)]
async fn pairing_forced_accepts_a_half_closed_request_stream() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let (client, relay) = duplex(2048);
    let (stdin, stdout) = tokio::io::split(relay);
    let (mut reader, mut writer) = tokio::io::split(client);
    write_pair_frame(&mut writer, &start(NONCE, 8))
        .await
        .unwrap();
    writer.shutdown().await.unwrap();
    let server = async {
        let (stream, _) = request(&listener).await;
        respond(stream, PairReply::Waiting).await;
        let (stream, _) = request(&listener).await;
        respond(stream, PairReply::Denied).await;
    };
    let client = async {
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Waiting
        );
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Denied
        );
    };
    let (code, (), ()) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::join!(run_forced(stdin, stdout, &socket), server, client)
    })
    .await
    .unwrap();
    assert_eq!(code, 2);
}

#[tokio::test(start_paused = true)]
async fn pairing_forced_retries_a_control_timeout_and_writes_waiting_once_then_expired() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let (client, relay) = duplex(2048);
    let (stdin, stdout) = tokio::io::split(relay);
    let (mut reader, mut writer) = tokio::io::split(client);
    let start = start(NONCE, 7);
    let server = async {
        let (stream, incoming) = request(&listener).await;
        assert!(
            matches!(incoming, ControlRequest::PairStart { start: ref received, .. } if received == &start)
        );
        respond(stream, PairReply::Waiting).await;
        let initial = tokio::time::Instant::now();
        let (stalled, incoming) = request(&listener).await;
        assert!(matches!(incoming, ControlRequest::PairStatus { nonce } if nonce == NONCE));
        assert_eq!(initial.elapsed(), Duration::from_secs(1));
        let (next, incoming) = request(&listener).await;
        assert!(matches!(incoming, ControlRequest::PairStatus { nonce } if nonce == NONCE));
        assert!(initial.elapsed() >= Duration::from_secs(11));
        respond(next, PairReply::Waiting).await;
        let (last, incoming) = request(&listener).await;
        assert!(matches!(incoming, ControlRequest::PairStatus { nonce } if nonce == NONCE));
        respond(last, PairReply::Expired).await;
        drop(stalled);
    };
    let client = async {
        write_pair_frame(&mut writer, &start).await.unwrap();
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Waiting
        );
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Expired
        );
    };
    let (code, (), ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(run_forced(stdin, stdout, &socket), server, client)
    })
    .await
    .unwrap();
    assert_eq!(code, 2);
}

#[tokio::test(start_paused = true)]
async fn pairing_forced_approves_and_refuses_cross_nonce_requests_or_a_missing_control_socket() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let (client, relay) = duplex(2048);
    let (stdin, stdout) = tokio::io::split(relay);
    let (mut reader, mut writer) = tokio::io::split(client);
    let start = start(NONCE, 8);
    let approve = PairReply::Approved {
        device: "123ABC".into(),
        hosts: vec![host()],
    };
    let exchange = async {
        write_pair_frame(&mut writer, &start).await.unwrap();
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Waiting
        );
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            approve
        );
    };
    let server = async {
        let (stream, request_type) = request(&listener).await;
        assert!(matches!(request_type, ControlRequest::PairStart { .. }));
        respond(stream, PairReply::Waiting).await;
        let (stream, request_type) = request(&listener).await;
        assert!(matches!(request_type, ControlRequest::PairStatus { .. }));
        respond(stream, approve.clone()).await;
    };
    let (code, (), ()) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::join!(
            run_forced_for_nonce(stdin, stdout, &socket, NONCE),
            exchange,
            server
        )
    })
    .await
    .unwrap();
    assert_eq!(code, 0);

    for (path, nonce, error) in [
        (&socket, "another-nonce", PairError::Unknown),
        (
            &dir.path().join("missing.sock"),
            NONCE,
            PairError::Unavailable,
        ),
    ] {
        let (client, relay) = duplex(2048);
        let (stdin, stdout) = tokio::io::split(relay);
        let (mut reader, mut writer) = tokio::io::split(client);
        write_pair_frame(&mut writer, &start).await.unwrap();
        assert_eq!(run_forced_for_nonce(stdin, stdout, path, nonce).await, 2);
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Error { error }
        );
    }
}
