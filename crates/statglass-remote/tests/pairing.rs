use p256::elliptic_curve::sec1::ToSec1Point;
use statglass_proto::pairing::{BundleHost, CODE_ALPHABET, PairError, PairReply, PairStart};
use statglass_remote::{
    AuthorizedKeys, ControlRequest, ControlResponse, DeviceKeys, DeviceKeysError, DeviceTag,
    EcdsaP256Public, PairCommands, PairedDevice, PairingError, PairingHost, bind_private,
    pairing::{run_forced, run_forced_for_nonce},
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

fn submit_start(pairing: &PairingHost, request: &PairStart, now_ms: i64) -> PairReply {
    relay_start(pairing, request, uuid::Uuid::new_v4().into_bytes(), now_ms)
}

fn relay_start(
    pairing: &PairingHost,
    request: &PairStart,
    attempt: [u8; 16],
    now_ms: i64,
) -> PairReply {
    pairing
        .control_reply(
            ControlRequest::PairStart {
                start: request.clone(),
                attempt,
            },
            now_ms,
        )
        .pairing
        .expect("pairing reply")
}

#[test]
fn closing_withdraws_open_offers_and_preserves_committed_replies() {
    let (pairing, keys) = pairing();
    let waiting = pairing.offer(host(), Duration::ZERO, NOW).unwrap();
    let pending = pairing.offer(host(), Duration::ZERO, NOW).unwrap();
    let expired = pairing.offer(host(), Duration::from_secs(1), NOW).unwrap();
    let approved = pairing.offer(host(), Duration::ZERO, NOW).unwrap();
    assert_eq!(
        submit_start(&pairing, &start(&pending.nonce, 2), NOW),
        PairReply::Waiting
    );
    assert_eq!(
        submit_start(&pairing, &start(&approved.nonce, 3), NOW),
        PairReply::Waiting
    );
    let approval = pairing.approve(&approved.nonce, NOW).unwrap();

    pairing.cancel_open(NOW + 1000);
    pairing.cancel_open(NOW + 1000);

    assert_eq!(
        pairing.status(&waiting.nonce, NOW + 1000),
        PairReply::Denied
    );
    assert_eq!(
        pairing.status(&pending.nonce, NOW + 1000),
        PairReply::Denied
    );
    assert_eq!(
        pairing.status(&expired.nonce, NOW + 1000),
        PairReply::Expired
    );
    assert_eq!(pairing.status(&approved.nonce, NOW + 1000), approval);
    assert!(matches!(
        pairing.offer(host(), Duration::ZERO, NOW + 1000),
        Err(PairingError::Closing)
    ));
    let edits = keys.edits.lock_ok();
    assert_eq!(edits.len(), 9);
    for nonce in [waiting.nonce, pending.nonce, expired.nonce, approved.nonce] {
        assert_eq!(
            edits
                .iter()
                .filter(|edit| **edit == Edit::Remove(nonce.clone()))
                .count(),
            1
        );
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
    assert_eq!(
        submit_start(&pairing, &request, NOW + 10),
        PairReply::Waiting
    );
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
            submit_start(&pairing, &start(&offer.nonce, 3), NOW),
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
        submit_start(&pairing, &invalid, NOW),
        PairReply::Error {
            error: PairError::Invalid
        }
    );
    assert_eq!(
        submit_start(&pairing, &start(NONCE, 4), NOW),
        PairReply::Error {
            error: PairError::Unknown
        }
    );
    assert_eq!(submit_start(&pairing, &same, NOW), PairReply::Waiting);
    for later in [&same, &different] {
        assert_eq!(
            submit_start(&pairing, later, NOW),
            PairReply::Error {
                error: PairError::Used
            }
        );
    }
    pairing.approve(&offer.nonce, NOW).unwrap();
    for later in [&same, &different] {
        assert_eq!(
            submit_start(&pairing, later, NOW),
            PairReply::Error {
                error: PairError::Used
            }
        );
    }
    let untouched = pairing.offer(host(), Duration::from_secs(1), NOW).unwrap();
    assert_eq!(
        submit_start(&pairing, &start(&untouched.nonce, 6), NOW + 1000),
        PairReply::Expired
    );
}

#[test]
fn pairing_retries_cleanup_before_reporting_approval_without_installing_twice() {
    let (pairing, keys) = pairing();
    let offer = pairing.offer(host(), Duration::from_secs(60), NOW).unwrap();
    assert_eq!(
        submit_start(&pairing, &start(&offer.nonce, 5), NOW),
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
        submit_start(&pairing, &request, NOW),
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
    respond_with_expiry(&mut stream, pairing, statglass_engine::wall_ms() + 60_000).await;
}

async fn respond_with_expiry(stream: &mut UnixStream, pairing: PairReply, expires_ms: i64) {
    let reply = ControlResponse {
        pairing_expires_ms: (pairing == PairReply::Waiting).then_some(expires_ms),
        pairing: Some(pairing),
        ok: true,
        message: String::new(),
        host: None,
        allow_remote_monitoring: None,
        show_menu_bar_icon: None,
        launch_at_login: None,
        updates: None,
    };
    write_control(stream, &reply).await;
}

async fn write_control(stream: &mut UnixStream, reply: &ControlResponse) {
    let body = serde_json::to_vec(reply).expect("encode the control reply frame");
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
async fn pairing_forced_refuses_an_expired_nonce_even_with_an_admitted_ssh_key() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let key_file = dir.path().join("authorized_keys");
    let host_state = PairingHost::new(
        Arc::new(AuthorizedKeys::at(key_file.clone())),
        PairCommands {
            pair: "/helper pair".into(),
            restricted: "/helper restricted".into(),
        },
    );
    let offer = host_state
        .offer(host(), Duration::from_secs(1), NOW)
        .unwrap();
    // The relay sees an expired offer at the same instant that sshd still
    // admits the key, as it can when an on-disk deadline outlasts the offer.
    let now_ms = offer.expires_ms + 1;
    let ssh_now = jiff::Timestamp::from_millisecond(now_ms).unwrap();
    let zone =
        jiff::tz::TimeZone::tzif("localtime", &std::fs::read("/etc/localtime").unwrap()).unwrap();
    let local_now = ssh_now.to_zoned(zone).strftime("%Y%m%d%H%M%S").to_string();
    let line = std::fs::read_to_string(&key_file).unwrap();
    let expiry = line
        .split("expiry-time=\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    let future_expiry = "20991231235959";
    std::fs::write(
        &key_file,
        line.replacen(
            &format!("expiry-time=\"{expiry}\""),
            &format!("expiry-time=\"{future_expiry}\""),
            1,
        ),
    )
    .unwrap();
    let line = std::fs::read_to_string(&key_file).unwrap();
    assert!(line.contains(&format!("expiry-time=\"{future_expiry}\"")));
    assert!(
        future_expiry > local_now.as_str(),
        "sshd's local clock still admits the key"
    );
    assert!(line.contains(&format!("/helper pair --nonce {}", offer.nonce)));

    let (client, relay) = duplex(2048);
    let (stdin, stdout) = tokio::io::split(relay);
    let (mut reader, mut writer) = tokio::io::split(client);
    let exchange = async {
        write_pair_frame(&mut writer, &start(&offer.nonce, 8))
            .await
            .unwrap();
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Expired
        );
    };
    let server = async {
        let (mut stream, request) = request(&listener).await;
        assert!(matches!(request, ControlRequest::PairStart { .. }));
        let response = host_state.control_reply(request, now_ms);
        write_control(&mut stream, &response).await;
    };
    let (code, (), ()) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::join!(
            run_forced_for_nonce(stdin, stdout, &socket, &offer.nonce),
            exchange,
            server
        )
    })
    .await
    .unwrap();
    assert_eq!(code, 2);
    assert_eq!(host_state.pending(&offer.nonce, now_ms), PairReply::Expired);
    assert!(std::fs::read_to_string(key_file).unwrap().is_empty());
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
            relay_start(&pairing, &first, attempt, NOW),
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
            relay_start(&pairing, &retry, different_attempt, NOW),
            PairReply::Error {
                error: PairError::Used
            }
        );
        let reply = relay_start(&pairing, &retry, retried_attempt, NOW);
        let waiting = reply == PairReply::Waiting;
        respond(stream, reply).await;
        drop(lost);
        if waiting {
            let (status, ControlRequest::PairStatus { nonce }) = request(&listener).await else {
                panic!("expected status poll")
            };
            let approved = pairing.approve(&nonce, NOW).unwrap();
            assert_eq!(relay_start(&pairing, &retry, attempt, NOW), approved);
            assert_eq!(
                relay_start(&pairing, &retry, different_attempt, NOW),
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
async fn pairing_forced_abandons_when_phone_disconnects_during_a_control_stall() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let (client, relay) = duplex(2048);
    let (stdin, stdout) = tokio::io::split(relay);
    let (mut reader, mut writer) = tokio::io::split(client);
    write_pair_frame(&mut writer, &start(NONCE, 8))
        .await
        .unwrap();
    let (poll_started, wedged) = tokio::sync::oneshot::channel();
    let (finished, client_finished) = tokio::sync::oneshot::channel();
    let server = async {
        let (stream, ControlRequest::PairStart { attempt, .. }) = request(&listener).await else {
            panic!("expected pairing start")
        };
        respond(stream, PairReply::Waiting).await;
        let (_stalled, poll) = request(&listener).await;
        assert!(matches!(poll, ControlRequest::PairStatus { nonce } if nonce == NONCE));
        poll_started.send(()).unwrap();
        let (_abandon, abandon) = request(&listener).await;
        assert!(
            matches!(abandon, ControlRequest::PairAbandon { nonce, attempt: abandoned } if nonce == NONCE && abandoned == attempt)
        );
        client_finished.await.unwrap();
    };
    let client = async {
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Waiting
        );
        wedged.await.unwrap();
        writer.shutdown().await.unwrap();
        assert!(read_pair_frame::<PairReply>(&mut reader).await.is_err());
        finished.send(()).unwrap();
    };
    let (code, (), ()) = tokio::time::timeout(Duration::from_secs(4), async {
        tokio::join!(run_forced(stdin, stdout, &socket), server, client)
    })
    .await
    .unwrap();
    assert_eq!(code, 2);
}

#[test]
fn pairing_abandon_prevents_approval_for_the_disconnected_attempt() {
    let (pairing, keys) = pairing();
    let offer = pairing.offer(host(), Duration::from_secs(60), NOW).unwrap();
    let nonce = &offer.nonce;
    let attempt = [9; 16];
    let started = pairing.control_reply(
        ControlRequest::PairStart {
            start: start(nonce, 7),
            attempt,
        },
        NOW,
    );
    assert_eq!(started.pairing, Some(PairReply::Waiting));
    assert_eq!(started.pairing_expires_ms, Some(offer.expires_ms));
    assert_eq!(
        pairing.abandon(nonce, [8; 16], NOW),
        PairReply::Error {
            error: PairError::Used
        }
    );
    let reply = pairing.control_reply(
        ControlRequest::PairAbandon {
            nonce: nonce.clone(),
            attempt,
        },
        NOW,
    );
    assert_eq!(reply.pairing, Some(PairReply::Expired));
    assert_eq!(reply.pairing_expires_ms, None);
    assert_eq!(pairing.approve(nonce, NOW).unwrap(), PairReply::Expired);
    let edits = keys.edits.lock_ok();
    assert_eq!(edits.len(), 2);
    assert_eq!(edits.last(), Some(&Edit::Remove(nonce.clone())));
}

#[tokio::test(start_paused = true)]
async fn pairing_forced_abandons_when_stdout_closes_before_waiting_is_delivered() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let (mut writer, stdin) = duplex(2048);
    let (reader, stdout) = duplex(2048);
    drop(reader);
    write_pair_frame(&mut writer, &start(NONCE, 5))
        .await
        .unwrap();
    let server = async {
        let (stream, ControlRequest::PairStart { attempt, .. }) = request(&listener).await else {
            panic!("expected pairing start")
        };
        respond(stream, PairReply::Waiting).await;
        let (stream, abandon) = request(&listener).await;
        assert!(
            matches!(abandon, ControlRequest::PairAbandon { nonce, attempt: abandoned } if nonce == NONCE && abandoned == attempt)
        );
        respond(stream, PairReply::Expired).await;
    };
    let (code, ()) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(run_forced(stdin, stdout, &socket), server)
    })
    .await
    .unwrap();
    assert_eq!(code, 2);
}

#[tokio::test(start_paused = true)]
async fn pairing_forced_retries_when_control_drops_the_first_status_connection() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let (client, relay) = duplex(2048);
    let (stdin, stdout) = tokio::io::split(relay);
    let (mut reader, mut writer) = tokio::io::split(client);
    let approved = PairReply::Approved {
        device: "123ABC".into(),
        hosts: vec![host()],
    };
    let server = async {
        let (stream, _) = request(&listener).await;
        respond(stream, PairReply::Waiting).await;
        let (stream, poll) = request(&listener).await;
        assert!(matches!(poll, ControlRequest::PairStatus { nonce } if nonce == NONCE));
        drop(stream);
        let (stream, poll) = request(&listener).await;
        assert!(matches!(poll, ControlRequest::PairStatus { nonce } if nonce == NONCE));
        respond(stream, approved.clone()).await;
    };
    let client = async {
        write_pair_frame(&mut writer, &start(NONCE, 1))
            .await
            .unwrap();
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Waiting
        );
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            approved
        );
    };
    let (code, (), ()) = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::join!(run_forced(stdin, stdout, &socket), server, client)
    })
    .await
    .unwrap();
    assert_eq!(code, 0);
}

#[tokio::test(start_paused = true)]
async fn pairing_forced_stops_retrying_at_the_hosts_actual_expiry() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("pair.sock");
    let listener = bind_private(&socket).unwrap();
    let (client, relay) = duplex(2048);
    let (stdin, stdout) = tokio::io::split(relay);
    let (mut reader, mut writer) = tokio::io::split(client);
    let (finished, client_finished) = tokio::sync::oneshot::channel();
    let server = async {
        let (mut stream, ControlRequest::PairStart { attempt, .. }) = request(&listener).await
        else {
            panic!("expected pairing start")
        };
        respond_with_expiry(
            &mut stream,
            PairReply::Waiting,
            statglass_engine::wall_ms() + 1_000,
        )
        .await;
        let (_stalled, poll) = request(&listener).await;
        assert!(matches!(poll, ControlRequest::PairStatus { nonce } if nonce == NONCE));
        let (_stalled_again, abandon) = request(&listener).await;
        assert!(
            matches!(abandon, ControlRequest::PairAbandon { nonce, attempt: abandoned } if nonce == NONCE && abandoned == attempt)
        );
        // Neither control response ever arrives while the relay is trying to finish.
        client_finished.await.unwrap();
    };
    let client = async {
        write_pair_frame(&mut writer, &start(NONCE, 1))
            .await
            .unwrap();
        assert_eq!(
            read_pair_frame::<PairReply>(&mut reader).await.unwrap(),
            PairReply::Waiting
        );
        let reply = tokio::time::timeout(
            Duration::from_secs(13),
            read_pair_frame::<PairReply>(&mut reader),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(reply, PairReply::Expired);
        finished.send(()).unwrap();
    };
    let (code, (), ()) = tokio::time::timeout(Duration::from_secs(30), async {
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
