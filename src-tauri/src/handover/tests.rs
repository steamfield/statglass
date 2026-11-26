use std::time::Duration;
use std::{collections::BTreeMap, sync::Mutex};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use statglass_proto::{handover::HandoverReason, pairing::BundleHost};
use statglass_remote::{AuthorizedKeys, DeviceKeys, EcdsaP256Public};
use statglass_schema::lock::LockExt;

use super::*;
use crate::pairing::tests::DEVICE_KEY;

const SECOND_DEVICE_KEY: [u8; 65] = [
    4, 111, 240, 59, 148, 146, 65, 206, 29, 173, 212, 53, 25, 230, 150, 14, 10, 133, 180, 26, 105,
    160, 92, 50, 129, 3, 170, 43, 206, 21, 148, 202, 22, 60, 79, 117, 58, 85, 191, 1, 220, 83, 246,
    192, 176, 199, 238, 231, 139, 64, 198, 255, 125, 37, 169, 110, 34, 130, 185, 137, 206, 247, 28,
    20, 74,
];

#[derive(Default)]
struct TestLog {
    records: Mutex<Vec<(HostId, DeviceTag, IntentOp)>>,
    outcomes: Mutex<Vec<(u64, Result<(), String>)>>,
}

impl IntentStore for Arc<TestLog> {
    fn record(
        &self,
        host: HostId,
        device: DeviceTag,
        op: IntentOp,
        _: i64,
    ) -> Result<u64, IntentError> {
        let mut records = self.records.lock_ok();
        records.push((host, device, op));
        Ok(records.len() as u64)
    }

    fn pending(&self) -> Result<Vec<PendingIntent>, IntentError> {
        let outcomes = self.outcomes.lock_ok();
        let records = self.records.lock_ok();
        let effective: BTreeMap<_, _> = records
            .iter()
            .enumerate()
            .map(|(i, (host, device, op))| ((*host, *device), (i, op)))
            .collect();
        Ok(effective
            .into_iter()
            .filter_map(|((host, device), (i, op))| {
                let seq = i as u64 + 1;
                let tried: Vec<_> = outcomes
                    .iter()
                    .filter(|(attempt, _)| *attempt == seq)
                    .collect();
                let last_error = match tried.last() {
                    Some((_, Ok(()))) => return None,
                    Some((_, Err(reason))) => Some(reason.clone()),
                    None => None,
                };
                let install = match op {
                    IntentOp::Install { name, key } => {
                        let bytes = STANDARD.decode(key).unwrap().try_into().unwrap();
                        Some((EcdsaP256Public(bytes), name.clone()))
                    }
                    IntentOp::Revoke => None,
                    _ => panic!("unexpected intent"),
                };
                Some(PendingIntent {
                    seq,
                    host,
                    device,
                    install,
                    attempts: tried.len() as u32,
                    last_error,
                })
            })
            .collect())
    }

    fn installed_hosts(&self, device: &DeviceTag) -> Result<Vec<HostId>, IntentError> {
        let mut installed = std::collections::BTreeSet::new();
        for (host, tag, op) in self
            .records
            .lock_ok()
            .iter()
            .filter(|(_, tag, _)| tag == device)
        {
            assert_eq!(tag, device);
            if matches!(op, IntentOp::Install { .. }) {
                installed.insert(*host);
            } else {
                installed.remove(host);
            }
        }
        Ok(installed.into_iter().collect())
    }

    fn finish(&self, seq: u64, result: Result<(), String>, _: i64) -> Result<(), IntentError> {
        self.outcomes.lock_ok().push((seq, result));
        Ok(())
    }
}

fn id(number: u128) -> HostId {
    HostId(uuid::Uuid::from_u128(number))
}

fn host(number: u128, enabled: bool) -> RemoteHost {
    RemoteHost {
        input: HandoverInput {
            host_id: id(number),
            name: format!("Host {number}"),
            os: "Linux".into(),
            lan: Some(format!("ssh-{number}")),
            tailscale: None,
        },
        enabled,
        aliases: Ok(vec![format!("ssh-{number}")]),
        command: RemoteCommand::Agent {
            bin: "/home/test user/bin/statglass-agent".into(),
            system: true,
            socket: Some("/var/run/statglass.sock".into()),
        },
    }
}

fn resolved(input: &HandoverInput) -> BundleHost {
    BundleHost {
        host_id: input.host_id,
        name: input.name.clone(),
        os: input.os.clone(),
        user: "test".into(),
        port: None,
        targets: Vec::new(),
        host_keys: Vec::new(),
    }
}

fn controller(
    log: impl IntentStore + 'static,
    hosts: impl Fn() -> Vec<RemoteHost> + Send + Sync + 'static,
) -> (Arc<Controller>, mpsc::UnboundedReceiver<Apply>) {
    let (apply, requests) = mpsc::unbounded_channel();
    (
        Arc::new(Controller {
            from: id(0),
            log: Ok(Box::new(log)),
            hosts: Box::new(hosts),
            apply,
        }),
        requests,
    )
}

fn update_offer(
    controller: &Controller,
    keys: &AuthorizedKeys,
    resolve: impl Fn(&HandoverInput) -> Result<BundleHost, HandoverReason>,
) -> HandoverOffer {
    let offer = controller.prepare_with(resolve).unwrap();
    controller.finish_offer(offer, keys).unwrap()
}

#[test]
fn approval_queues_only_enabled_hosts_the_phone_can_reach() {
    let log = Arc::new(TestLog::default());
    let (controller, _requests) =
        controller(log, || vec![host(1, true), host(2, true), host(3, false)]);
    let key = EcdsaP256Public(DEVICE_KEY);
    let tag = DeviceTag::from_key(&key);
    let offered = controller.approve(tag, &key, "Travel iPhone", |input| {
        assert_ne!(input.host_id, id(3), "disabled hosts must not be resolved");
        if input.host_id == id(2) {
            Err(HandoverReason::ProxyJump)
        } else {
            Ok(resolved(input))
        }
    });
    assert_eq!(offered.hosts[0].host_id, id(1));
    assert_eq!(offered.hosts.len(), 1);
    assert_eq!(offered.unavailable.len(), 1);
    assert_eq!(offered.unavailable[0].host_id, id(2));
    assert_eq!(offered.unavailable[0].reason, HandoverReason::ProxyJump);
    let intents = controller.pending_info().unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(intents[0].host_name, "Host 1");
    assert_eq!(intents[0].device_name, "Travel iPhone");
    assert_eq!(intents[0].device, tag.to_string());
    assert_eq!(intents[0].state, "pending");
}

#[test]
fn update_queues_new_hosts_for_each_enrolled_key_once() {
    let dir = tempfile::tempdir().unwrap();
    let keys = AuthorizedKeys::at(dir.path().join("authorized_keys"));
    let key = EcdsaP256Public(DEVICE_KEY);
    let tag = keys
        .add_device(&key, "Travel iPhone", "/helper restricted")
        .unwrap();
    let second_key = EcdsaP256Public(SECOND_DEVICE_KEY);
    let second = keys
        .add_device(&second_key, "Desk iPhone", "/helper restricted")
        .unwrap();
    let log = Arc::new(TestLog::default());
    let (controller, _) = controller(log.clone(), || {
        vec![host(1, true), host(2, true), host(3, true)]
    });
    let previous = controller.approve(tag, &key, "Travel iPhone", |input| {
        if input.host_id == id(1) {
            Ok(resolved(input))
        } else {
            Err(HandoverReason::Unresolvable)
        }
    });
    assert_eq!(previous.hosts.len(), 1);
    log.finish(1, Ok(()), wall_ms()).unwrap();
    controller.approve(second, &second_key, "Desk iPhone", |input| {
        if input.host_id == id(2) {
            Ok(resolved(input))
        } else {
            Err(HandoverReason::Unresolvable)
        }
    });
    log.finish(2, Ok(()), wall_ms()).unwrap();
    let mut pending_seqs = Vec::new();
    for _ in 0..2 {
        let offer = update_offer(&controller, &keys, |input| {
            if input.host_id == id(3) {
                Err(HandoverReason::NoHostKey)
            } else {
                Ok(resolved(input))
            }
        });
        assert_eq!(offer.hosts, ["Host 1", "Host 2"]);
        assert_eq!(offer.unavailable[0].reason, HandoverReasonInfo::NoHostKey);
        assert!(offer.qr_svg.contains("<svg"));
        assert!(offer.text.starts_with("SGB1:"));
        let pending = log.pending().unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!((pending[0].host, pending[0].device), (id(1), second));
        assert_eq!(
            pending[0].install,
            Some((second_key.clone(), "Desk iPhone".into()))
        );
        assert_eq!((pending[1].host, pending[1].device), (id(2), tag));
        assert_eq!(
            pending[1].install,
            Some((key.clone(), "Travel iPhone".into()))
        );
        pending_seqs.push(pending.iter().map(|intent| intent.seq).collect::<Vec<_>>());
    }
    assert_eq!(
        pending_seqs[0], pending_seqs[1],
        "reopening must retain pending installs"
    );
}

#[test]
fn revoke_records_applied_and_pending_installs_even_for_a_removed_host() {
    let log = Arc::new(TestLog::default());
    let (controller, _) = controller(log.clone(), || vec![host(1, true)]);
    let key = EcdsaP256Public(DEVICE_KEY);
    let tag = DeviceTag::from_key(&key);
    let op = IntentOp::Install {
        key: "key".into(),
        name: "Home iPhone".into(),
    };
    log.record(id(1), tag, op.clone(), wall_ms()).unwrap();
    log.finish(1, Ok(()), wall_ms()).unwrap();
    log.record(id(2), tag, op, wall_ms()).unwrap();
    controller.revoke(tag).unwrap();
    controller.revoke(tag).unwrap();
    let pending = controller.pending_info().unwrap();
    assert_eq!(
        pending.iter().map(|intent| intent.host).collect::<Vec<_>>(),
        [id(1), id(2)]
    );
    assert!(
        pending
            .iter()
            .all(|intent| intent.op == "revoke" && intent.device == tag.to_string())
    );
}

#[test]
fn sends_device_operations_to_the_configured_program_with_literal_arguments() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::{os::unix::fs::PermissionsExt, process::Command};

    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("statglass agent");
    std::fs::write(&bin, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
    let bin = bin.to_str().unwrap();
    let agent = RemoteCommand::Agent {
        bin: bin.into(),
        system: true,
        socket: Some("/run/statglass user.sock".into()),
    };
    let helper = RemoteCommand::MacHelper(bin.into());
    let key = EcdsaP256Public(DEVICE_KEY);
    let tag = DeviceTag::from_key(&key);
    let name = r#"Riley's iPhone \$second"#;
    let mut intent = PendingIntent {
        host: id(1),
        device: tag,
        seq: 1,
        install: Some((key, name.into())),
        attempts: 0,
        last_error: None,
    };
    let send = |program: &RemoteCommand, intent: &PendingIntent| {
        let output = Command::new("/bin/sh")
            .args(["-c", &worker::device_command(program, intent).unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap()
    };
    let key = STANDARD.encode(DEVICE_KEY);
    assert!(
        worker::device_command(&agent, &intent)
            .unwrap()
            .starts_with("exec /bin/sh -c '")
    );
    assert_eq!(
        send(&agent, &intent),
        format!(
            "authorize-key\n--key\n{key}\n--name\n{name}\n--system\n--socket\n/run/statglass user.sock\n"
        )
    );
    assert_eq!(
        send(&helper, &intent),
        format!("authorize-key\n--key\n{key}\n--name\n{name}\n")
    );
    intent.install = None;
    assert_eq!(
        send(&agent, &intent),
        format!("revoke-key\n--device\n{tag}\n")
    );
    assert_eq!(
        send(&helper, &intent),
        format!("revoke-key\n--device\n{tag}\n")
    );
}

#[tokio::test]
#[ignore = "requires lane a's pairing approval hook and intent log"]
async fn pairing_approval_and_revoke_commands_use_the_durable_log() {
    use crate::pairing::{PairingStatus, pairing_approve, revoke_device, tests::app};
    use statglass_proto::pairing::{PairReply, PairStart};
    use statglass_remote::{ControlRequest, Handover};

    struct ResolvedSource(Arc<Controller>);
    impl HandoverSource for ResolvedSource {
        fn handover(&self, device: DeviceTag, key: &EcdsaP256Public, name: &str) -> Handover {
            self.0.approve(device, key, name, |input| {
                if input.host_id == id(2) {
                    Err(HandoverReason::ProxyJump)
                } else {
                    Ok(resolved(input))
                }
            })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("device-intents.jsonl");
    let log = IntentLog::open(path.clone()).unwrap();
    let (controller, _requests) = controller(log, || vec![host(1, true), host(2, true)]);
    let app = app(dir.path());
    assert!(
        app.state::<HandoverState>()
            .controller
            .set(controller.clone())
            .is_ok()
    );
    let pairing = app.state::<PairingState>();
    pairing.set_enabled(true);
    let pairing_host = pairing.host().unwrap();
    pairing_host.set_handover(Arc::new(ResolvedSource(controller.clone())));

    let now = wall_ms();
    let local = resolved(&host(0, true).input);
    let offer = pairing_host
        .offer(local.clone(), Duration::ZERO, now)
        .unwrap();
    let nonce = offer.nonce;
    let reply = pairing_host.control_reply(
        ControlRequest::PairStart {
            start: PairStart {
                nonce: nonce.clone(),
                device_name: "Travel iPhone".into(),
                model: "iPhone 16".into(),
                device_key: DEVICE_KEY.into(),
            },
            attempt: [1; 16],
        },
        now,
    );
    assert_eq!(reply.pairing, Some(PairReply::Waiting));
    let PairingStatus::Paired { device, .. } =
        pairing_approve(nonce.clone(), app.state()).await.unwrap()
    else {
        panic!("the pending iPhone should be approved")
    };
    let PairReply::Approved {
        hosts, unavailable, ..
    } = pairing_host.status(&nonce, now)
    else {
        panic!("the phone should receive its approval")
    };
    assert_eq!(hosts, [local, resolved(&host(1, true).input)]);
    assert_eq!(unavailable.len(), 1);
    assert_eq!(unavailable[0].reason, HandoverReason::ProxyJump);
    let reopened = IntentLog::open(path).unwrap();
    let pending = reopened.pending().unwrap();
    assert_eq!(pending.len(), 1);
    reopened.mark_applied(pending[0].seq, now).unwrap();

    let keys = AuthorizedKeys::at(dir.path().join("authorized_keys"));
    for _ in 0..2 {
        update_offer(&controller, &keys, |input| Ok(resolved(input)));
    }
    let installs = reopened.pending().unwrap();
    assert_eq!(installs.len(), 1);
    assert_eq!(installs[0].host, id(2));
    assert!(installs[0].install.is_some());

    assert!(
        revoke_device(device.clone(), app.state(), app.state())
            .await
            .unwrap()
    );
    let mut pending = device_intents(app.state()).await.unwrap();
    pending.sort_by_key(|intent| intent.host);
    assert_eq!(
        pending.iter().map(|intent| intent.host).collect::<Vec<_>>(),
        [id(1), id(2)]
    );
    assert!(
        pending
            .iter()
            .all(|intent| intent.device == device && intent.op == "revoke")
    );
}

#[test]
#[ignore = "requires lane c's bundle codec"]
fn update_encodes_ten_hosts_in_under_1200_bytes() {
    use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
    use sha2::{Digest, Sha256};
    use statglass_proto::{
        handover::decode_bundle,
        pairing::{BundleHostKey, BundleRoute, BundleTarget},
    };

    let dir = tempfile::tempdir().unwrap();
    let keys = AuthorizedKeys::at(dir.path().join("authorized_keys"));
    let (controller, _) = controller(Arc::new(TestLog::default()), || {
        (1..=10).map(|number| host(number, true)).collect()
    });
    let resolve = |input: &HandoverInput| {
        let mut host = resolved(input);
        host.targets.push(BundleTarget {
            route: BundleRoute::Lan,
            host: format!("{}.local", input.lan.as_deref().unwrap()),
        });
        let digest = Sha256::digest(input.host_id.to_string());
        host.host_keys.push(BundleHostKey {
            algorithm: "ssh-ed25519".into(),
            sha256: format!("SHA256:{}", STANDARD_NO_PAD.encode(digest)),
        });
        Ok(host)
    };
    let before = update_offer(&controller, &keys, resolve);
    keys.add_device(
        &EcdsaP256Public(DEVICE_KEY),
        "Phone 1",
        "/helper restricted",
    )
    .unwrap();
    keys.add_device(
        &EcdsaP256Public(SECOND_DEVICE_KEY),
        "Phone 2",
        "/helper restricted",
    )
    .unwrap();
    let offer = update_offer(&controller, &keys, resolve);
    println!("Ten-host offer text: {} bytes", offer.text.len());
    let mut without_devices = decode_bundle(&before.text).unwrap();
    without_devices.issued_ms = offer.issued_ms;
    let decoded = decode_bundle(&offer.text).unwrap();
    assert_eq!(decoded, without_devices);
    assert_eq!(decoded.hosts.len(), 10);
    assert_eq!(decoded.from, id(0));
    assert_eq!(decoded.issued_ms, offer.issued_ms);
    assert!(offer.text.len() < 1200, "{} bytes", offer.text.len());
}

#[tokio::test(start_paused = true)]
async fn applier_handles_connect_retry_and_periodic_attempts() {
    let log = Arc::new(TestLog::default());
    let (controller, requests) = controller(log.clone(), || vec![host(1, true), host(2, true)]);
    let tag = DeviceTag::from_key(&EcdsaP256Public(DEVICE_KEY));
    log.record(id(1), tag, IntentOp::Revoke, wall_ms()).unwrap();
    log.record(id(2), tag, IntentOp::Revoke, wall_ms()).unwrap();
    let (stop, stopped) = watch::channel(false);
    let (calls, mut observed) = mpsc::unbounded_channel();
    let task = tokio::spawn(worker::run_with(
        controller.clone(),
        requests,
        stopped,
        move |alias, command| {
            let calls = calls.clone();
            async move {
                calls.send((alias.clone(), command)).unwrap();
                if alias == "ssh-1" {
                    Ok(format!("{tag}\n"))
                } else {
                    Err("SSH authentication failed.".into())
                }
            }
        },
    ));
    let state = HandoverState {
        controller: OnceLock::from(controller.clone()),
    };
    state.connected(id(1));
    let (alias, command) = observed.recv().await.unwrap();
    assert_eq!(alias, "ssh-1");
    assert!(command.contains(&format!("revoke-key --device {tag}")));
    assert!(observed.try_recv().is_err());

    let (done, result) = oneshot::channel();
    controller.apply.send(Apply::Retry(done)).unwrap();
    assert_eq!(observed.recv().await.unwrap().0, "ssh-2");
    result.await.unwrap().unwrap();
    let pending = controller.pending_info().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].attempts, 1);
    assert_eq!(
        pending[0].reason.as_deref(),
        Some("SSH authentication failed.")
    );
    assert_eq!(pending[0].state, "failed");

    tokio::time::advance(Duration::from_secs(300)).await;
    let (alias, _) = tokio::time::timeout(Duration::from_millis(100), observed.recv())
        .await
        .expect("the five-minute tick should retry pending intents")
        .unwrap();
    assert_eq!(alias, "ssh-2");
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn applier_times_out_a_stalled_host_without_blocking_another_host() {
    let log = Arc::new(TestLog::default());
    let (controller, requests) = controller(log.clone(), || vec![host(1, true), host(2, true)]);
    let tag = DeviceTag::from_key(&EcdsaP256Public(DEVICE_KEY));
    log.record(id(1), tag, IntentOp::Revoke, wall_ms()).unwrap();
    log.record(id(2), tag, IntentOp::Revoke, wall_ms()).unwrap();
    let (stop, stopped) = watch::channel(false);
    let (calls, mut observed) = mpsc::unbounded_channel();
    let task = tokio::spawn(worker::run_with(
        controller.clone(),
        requests,
        stopped,
        move |alias, _| {
            let calls = calls.clone();
            async move {
                calls.send(alias.clone()).unwrap();
                if alias == "ssh-1" {
                    std::future::pending().await
                } else {
                    Ok(tag.to_string())
                }
            }
        },
    ));
    let (done, mut result) = oneshot::channel();
    controller.apply.send(Apply::Retry(done)).unwrap();
    let start = tokio::time::Instant::now();
    let mut called = [
        observed.recv().await.unwrap(),
        observed.recv().await.unwrap(),
    ];
    called.sort();
    assert_eq!(called, ["ssh-1", "ssh-2"]);
    assert_eq!(tokio::time::Instant::now(), start);
    tokio::time::advance(Duration::from_secs(19)).await;
    assert!(matches!(
        result.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::time::timeout(Duration::from_millis(100), result)
        .await
        .expect("retry should settle after the 20-second host deadline")
        .unwrap()
        .unwrap();
    let pending = controller.pending_info().unwrap();
    assert_eq!(pending.len(), 1);
    assert!(pending[0].reason.as_deref().unwrap().contains("20-second"));
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn a_revoke_supersedes_an_install_waiting_behind_other_ssh_work() {
    let log = Arc::new(TestLog::default());
    let (controller, requests) = controller(log.clone(), || vec![host(1, true)]);
    let first = DeviceTag::from_key(&EcdsaP256Public(DEVICE_KEY));
    let second = DeviceTag::from_key(&EcdsaP256Public(SECOND_DEVICE_KEY));
    log.record(id(1), first, IntentOp::Revoke, wall_ms())
        .unwrap();
    log.record(
        id(1),
        second,
        IntentOp::Install {
            key: STANDARD.encode(SECOND_DEVICE_KEY),
            name: "Desk iPhone".into(),
        },
        wall_ms(),
    )
    .unwrap();
    let (release, blocker) = oneshot::channel();
    let blocker = Arc::new(Mutex::new(Some(blocker)));
    let (calls, mut seen) = mpsc::unbounded_channel();
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(worker::run_with(
        controller.clone(),
        requests,
        stopped,
        move |_, command| {
            let calls = calls.clone();
            let blocker = blocker.clone();
            async move {
                let is_first = command.contains(&first.to_string());
                calls.send(command).unwrap();
                if is_first {
                    let wait = blocker.lock_ok().take().unwrap();
                    wait.await.unwrap();
                }
                Ok(if is_first { first } else { second }.to_string())
            }
        },
    ));
    let (done, result) = oneshot::channel();
    controller.apply.send(Apply::Retry(done)).unwrap();
    assert!(
        seen.recv()
            .await
            .unwrap()
            .contains(&format!("revoke-key --device {first}"))
    );
    controller.revoke(second).unwrap();
    release.send(()).unwrap();
    result.await.unwrap().unwrap();
    assert!(
        seen.recv()
            .await
            .unwrap()
            .contains(&format!("revoke-key --device {second}"))
    );
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn retry_revokes_on_a_disabled_host_and_requires_the_device_tag() {
    let log = Arc::new(TestLog::default());
    let (controller, requests) = controller(log.clone(), || vec![host(1, false)]);
    let tag = DeviceTag::from_key(&EcdsaP256Public(DEVICE_KEY));
    log.record(id(1), tag, IntentOp::Revoke, wall_ms()).unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(worker::run_with(
        controller.clone(),
        requests,
        stopped,
        move |alias, command| {
            let call = calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            async move {
                assert_eq!(alias, "ssh-1");
                assert!(command.contains(&format!("revoke-key --device {tag}")));
                Ok(match call {
                    0 => String::new(),
                    1 => "000000\n".into(),
                    _ => format!("{tag}\n"),
                })
            }
        },
    ));
    for attempts in 1..=3 {
        let (done, result) = oneshot::channel();
        controller.apply.send(Apply::Retry(done)).unwrap();
        result.await.unwrap().unwrap();
        let pending = controller.pending_info().unwrap();
        if attempts < 3 {
            assert_eq!(pending[0].attempts, attempts);
            assert!(
                pending[0]
                    .reason
                    .as_deref()
                    .unwrap()
                    .contains("confirm the device tag")
            );
        } else {
            assert!(pending.is_empty());
        }
    }
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn a_journal_error_does_not_leave_the_local_phone_authorized() {
    use crate::pairing::{paired_devices, revoke_device, tests::app};

    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let keys = AuthorizedKeys::at(dir.path().join("authorized_keys"));
    let tag = keys
        .add_device(
            &EcdsaP256Public(DEVICE_KEY),
            "Home iPhone",
            "/helper restricted",
        )
        .unwrap();
    let (mut controller, _requests) = controller(Arc::new(TestLog::default()), Vec::new);
    Arc::get_mut(&mut controller).unwrap().log =
        Err(IntentError::Invalid("Journal not writable.".into()));
    assert!(
        app.state::<HandoverState>()
            .controller
            .set(controller)
            .is_ok()
    );
    assert!(
        matches!(revoke_device(tag.to_string(), app.state(), app.state()).await,
        Err(CommandError::Handover { message }) if message.contains("Access is revoked on this Mac")
            && message.contains("Journal not writable."))
    );
    assert!(paired_devices(app.state()).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_local_revoke_error_preserves_the_remote_install_for_retry() {
    use crate::pairing::{revoke_device, tests::app};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorized_keys");
    let keys = AuthorizedKeys::at(path.clone());
    let key = EcdsaP256Public(DEVICE_KEY);
    let tag = keys
        .add_device(&key, "Home iPhone", "/helper restricted")
        .unwrap();
    let app = app(dir.path());
    let log = Arc::new(TestLog::default());
    let (controller, _requests) = controller(log.clone(), || vec![host(1, true)]);
    controller.approve(tag, &key, "Home iPhone", |input| Ok(resolved(input)));
    assert!(
        app.state::<HandoverState>()
            .controller
            .set(controller)
            .is_ok()
    );
    let backup = path.with_extension("backup");
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(matches!(
        revoke_device(tag.to_string(), app.state(), app.state()).await,
        Err(CommandError::Pairing { .. })
    ));
    assert_eq!(log.installed_hosts(&tag).unwrap(), [id(1)]);
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(backup, &path).unwrap();
    assert!(
        revoke_device(tag.to_string(), app.state(), app.state())
            .await
            .unwrap()
    );
    let pending = device_intents(app.state()).await.unwrap();
    assert_eq!(pending[0].op, "revoke");
}
