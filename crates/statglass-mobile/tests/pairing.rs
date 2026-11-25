use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use statglass_engine::wall_ms;
use statglass_ipc::mobile::{MobileCommand, MobileConfig, MobileHost, MobileTarget};
use statglass_ipc::status::RemoteRoute;
use statglass_mobile::{CoreEvents, MobileCore, NativeSigner, NativeSignerError};
use statglass_proto::pairing::{
    BundleHost, BundleHostKey, BundleRoute, BundleTarget, PAYLOAD_VERSION, PairingPayload,
    encode_payload,
};
use statglass_schema::{HostId, lock::LockExt};
use statglass_ssh::SoftwareSigner;
use tempfile::TempDir;
use tokio::runtime::Runtime;

struct NativeKey(Mutex<Option<Vec<u8>>>);

impl NativeSigner for NativeKey {
    fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
        self.0
            .lock_ok()
            .clone()
            .ok_or_else(|| NativeSignerError::Unavailable {
                message: "No readable phone key".into(),
            })
    }

    fn sign(&self, _: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
        panic!("no SSH peer in this test should request a signature");
    }
}

struct NoEvents;

impl CoreEvents for NoEvents {
    fn live(&self, _: u32, _: String) -> bool {
        false
    }

    fn event(&self, _: String) {}
}

fn key() -> Vec<u8> {
    SoftwareSigner::generate().public_key().to_vec()
}

fn core(dir: &TempDir, key: &[u8], hosts: Vec<MobileHost>) -> Arc<MobileCore> {
    core_with_signer(
        dir,
        Arc::new(NativeKey(Mutex::new(Some(key.to_vec())))),
        hosts,
    )
}

fn core_with_signer(
    dir: &TempDir,
    signer: Arc<NativeKey>,
    hosts: Vec<MobileHost>,
) -> Arc<MobileCore> {
    let core = MobileCore::new(signer, Arc::new(NoEvents));
    let config = MobileConfig {
        hosts,
        ..Default::default()
    };
    let result = core.start(
        dir.path().display().to_string(),
        serde_json::to_string(&config).expect("mobile config JSON"),
    );
    assert_eq!(
        serde_json::from_str::<Value>(&result).expect("start response envelope"),
        json!({"status": "ok", "data": null})
    );
    core
}

async fn call(core: &MobileCore, method: &str, args: Value) -> Value {
    serde_json::from_str(&core.call(method.into(), args.to_string()).await)
        .expect("core response envelope")
}

async fn roster(core: &MobileCore) -> Vec<(Value, Value)> {
    let reply = call(core, "list_hosts", Value::Null).await;
    assert_eq!(reply["status"], "ok", "{reply}");
    reply["data"]
        .as_array()
        .expect("list_hosts returns host records")
        .iter()
        .map(|host| (host["id"].clone(), host["display_name"].clone()))
        .collect()
}

fn host_rows(hosts: &[&MobileHost]) -> Vec<(Value, Value)> {
    hosts
        .iter()
        .map(|host| (json!(host.id), json!(host.name)))
        .collect()
}

fn host(n: u8) -> MobileHost {
    MobileHost {
        id: HostId(
            format!("00000000-0000-0000-0000-{n:012x}")
                .parse()
                .expect("fixture UUID"),
        ),
        name: format!("Host {n}"),
        user: "statglass".into(),
        port: Some(1),
        targets: vec![MobileTarget {
            route: RemoteRoute::Lan,
            host: "127.0.0.1".into(),
        }],
        // The registry records an open error before the production dialer can open a socket.
        host_keys: vec![],
        command: MobileCommand::Restricted,
    }
}

#[test]
fn preview_returns_the_offer_and_distinguishes_expiry_from_malformed_text() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(&dir, &key(), vec![]);
    let mut payload = PairingPayload {
        version: PAYLOAD_VERSION,
        host: BundleHost {
            host_id: host(1).id,
            name: "Studio".into(),
            os: "macos".into(),
            user: "monitor".into(),
            port: Some(2222),
            targets: vec![
                BundleTarget {
                    route: BundleRoute::Tailscale,
                    host: "study.tailnet".into(),
                },
                BundleTarget {
                    route: BundleRoute::Lan,
                    host: "study.local".into(),
                },
            ],
            host_keys: vec![BundleHostKey {
                algorithm: "ssh-ed25519".into(),
                sha256: "SHA256:fixture".into(),
            }],
        },
        pairing_key: [7; 32],
        nonce: "55bb3aa9cf3c45d7df0b70dd41999f43".into(),
        code: "AAA222".into(),
        expires_ms: wall_ms() + 60_000,
        can_hand_over: true,
    };
    let text = encode_payload(&payload);
    let mut bad_checksum = text.clone();
    bad_checksum.replace_range(5..6, if &text[5..6] == "0" { "1" } else { "0" });
    Runtime::new().unwrap().block_on(async {
        let reply = call(&core, "preview_pairing", json!({"text": format!(" \n{text}\t ")})).await;
        assert_eq!(reply, json!({"status": "ok", "data": {
            "host_id": payload.host.host_id, "name": "Studio", "os": "macos", "user": "monitor",
            "targets": [{"route": "tailscale", "host": "study.tailnet"}, {"route": "lan", "host": "study.local"}],
            "code": "AAA222", "expires_ms": payload.expires_ms, "can_hand_over": true,
        }}));

        payload.version += 1;
        for bad in [&bad_checksum, &encode_payload(&payload), "SGP1:0", "not a pairing code"] {
            let reply = call(&core, "preview_pairing", json!({"text": bad})).await;
            assert_eq!(reply["error"]["kind"], "pairing", "{reply}");
            assert_eq!(reply["error"]["reason"], "invalid", "{reply}");
        }
        payload.version = PAYLOAD_VERSION;
        payload.expires_ms = 0;
        let reply = call(&core, "preview_pairing", json!({"text": encode_payload(&payload)})).await;
        assert_eq!(reply["error"]["kind"], "pairing", "{reply}");
        assert_eq!(reply["error"]["reason"], "expired", "{reply}");
        let reply = call(&core, "pair", json!({"text": "invalid", "device_name": "Phone", "model": "iPhone"})).await;
        assert_eq!(reply["error"]["kind"], "pairing", "{reply}");
        assert_eq!(reply["error"]["reason"], "invalid", "{reply}");
        assert!(roster(&core).await.is_empty());
        assert!(!dir.path().join("hosts.json").exists());
    });
}

#[test]
fn persisted_roster_reopens_merges_with_config_and_reports_a_changed_key() {
    let dir = tempfile::tempdir().unwrap();
    let original_key = key();
    let (host, other) = (host(1), host(2));
    let fresh = core(&dir, &original_key, vec![]);
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        assert_eq!(
            call(&fresh, "pairing_state", Value::Null).await,
            json!({"status": "ok", "data": {"hosts": 0, "key_changed": false}})
        );
        assert_eq!(
            call(&fresh, "set_hosts", json!({"hosts": [&host, &other]})).await,
            json!({"status": "ok", "data": null})
        );
    });
    drop(fresh);

    let path = dir.path().join("hosts.json");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        saved,
        json!({"device_key": STANDARD.encode(&original_key), "hosts": [&host, &other]})
    );

    let same = core(&dir, &original_key, vec![]);
    rt.block_on(async {
        assert_eq!(roster(&same).await, host_rows(&[&host, &other]));
        assert_eq!(
            call(&same, "pairing_state", Value::Null).await,
            json!({"status": "ok", "data": {"hosts": 2, "key_changed": false}})
        );
    });
    drop(same);

    let replacement_key = key();
    let restored = core(&dir, &replacement_key, vec![]);
    rt.block_on(async {
        assert_eq!(roster(&restored).await, host_rows(&[&host, &other]));
        assert_eq!(
            call(&restored, "pairing_state", Value::Null).await,
            json!({"status": "ok", "data": {"hosts": 2, "key_changed": true}})
        );
    });
    drop(restored);

    let override_host = MobileHost {
        name: "Debug override".into(),
        ..host.clone()
    };
    let debug = MobileHost {
        id: HostId("00000000-0000-0000-0000-000000000003".parse().unwrap()),
        name: "Debug first".into(),
        ..host.clone()
    };
    let old_file = fs::File::open(&path).unwrap();
    let merged = core(
        &dir,
        &original_key,
        vec![debug.clone(), override_host.clone()],
    );
    rt.block_on(async {
        assert_eq!(
            roster(&merged).await,
            host_rows(&[&debug, &override_host, &other])
        );
        let missing = json!({"host": "00000000-0000-0000-0000-000000000004"});
        assert_eq!(
            call(&merged, "remove_host", missing.clone()).await,
            json!({"status": "error", "error": {"kind": "unknown_host", "host": missing["host"]}})
        );
        assert_eq!(
            call(&merged, "remove_host", json!({"host": host.id})).await,
            json!({"status": "ok", "data": null})
        );
        assert_eq!(roster(&merged).await, host_rows(&[&debug, &other]));
    });
    drop(merged);
    // The old file descriptor still reads the original roster after the atomic replacement.
    assert_eq!(
        serde_json::from_reader::<_, Value>(old_file).unwrap(),
        saved
    );

    let restarted = core(&dir, &original_key, vec![]);
    assert_eq!(
        rt.block_on(roster(&restarted)),
        host_rows(&[&debug, &other])
    );
}

#[test]
fn corrupt_roster_is_quarantined_and_startup_still_succeeds() {
    #[cfg(target_os = "macos")]
    let (_subscriber, warnings) = capture_store_warnings();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    fs::write(&path, "{broken").unwrap();
    let signing_key = key();
    let first = core(&dir, &signing_key, vec![]);
    assert!(!path.exists());
    let quarantined: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|entry| {
            entry
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("hosts.json.corrupt-")
        })
        .collect();
    assert_eq!(quarantined.len(), 1);
    assert_eq!(fs::read_to_string(&quarantined[0]).unwrap(), "{broken");
    let rt = Runtime::new().unwrap();
    assert!(rt.block_on(roster(&first)).is_empty());
    drop(first);
    let second = core(&dir, &signing_key, vec![]);
    assert!(rt.block_on(roster(&second)).is_empty());
    assert!(!path.exists());
    #[cfg(target_os = "macos")]
    assert_eq!(warnings.load(std::sync::atomic::Ordering::Relaxed), 1);
}

#[cfg(target_os = "macos")]
fn capture_store_warnings() -> (
    tracing::subscriber::DefaultGuard,
    Arc<std::sync::atomic::AtomicUsize>,
) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tracing_subscriber::{Layer, layer::Context, prelude::*};

    struct Warnings(Arc<AtomicUsize>);

    impl<S: tracing::Subscriber> Layer<S> for Warnings {
        fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
            let meta = event.metadata();
            if meta.target() == "statglass_mobile::host_store"
                && *meta.level() == tracing::Level::WARN
            {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    let count = Arc::new(AtomicUsize::new(0));
    let guard = tracing::subscriber::set_default(
        tracing_subscriber::registry().with(Warnings(count.clone())),
    );
    (guard, count)
}

#[test]
fn startup_survives_an_unreadable_roster_without_replacing_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    std::os::unix::fs::symlink("hosts.json", &path).unwrap();
    let core = core(&dir, &key(), vec![]);
    Runtime::new().unwrap().block_on(async {
        assert!(roster(&core).await.is_empty());
        let reply = call(&core, "set_hosts", json!({"hosts": [host(1)]})).await;
        assert_eq!(reply["error"]["kind"], "store", "{reply}");
        assert!(roster(&core).await.is_empty());
    });
    assert_eq!(
        fs::read_link(&path).unwrap(),
        std::path::Path::new("hosts.json")
    );
}

#[test]
fn durable_hosts_require_a_key_and_stay_listed_if_the_signer_becomes_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let signer = Arc::new(NativeKey(Mutex::default()));
    let host = host(1);
    let fresh = core_with_signer(&dir, signer.clone(), vec![]);
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let response = call(&fresh, "set_hosts", json!({"hosts": [&host]})).await;
        assert_eq!(
            response["error"]["kind"], "phone_key_unavailable",
            "{response}"
        );
        assert!(!dir.path().join("hosts.json").exists());
        assert!(roster(&fresh).await.is_empty());
        *signer.0.lock_ok() = Some(key());
        let response = call(&fresh, "set_hosts", json!({"hosts": [&host]})).await;
        assert_eq!(response, json!({"status": "ok", "data": null}));
    });
    drop(fresh);

    *signer.0.lock_ok() = None;
    let restored = core_with_signer(&dir, signer.clone(), vec![]);
    rt.block_on(async {
        assert_eq!(roster(&restored).await, host_rows(&[&host]));
        assert_eq!(
            call(&restored, "pairing_state", Value::Null).await,
            json!({"status": "ok", "data": {"hosts": 1, "key_changed": false}})
        );
        *signer.0.lock_ok() = Some(key());
        assert_eq!(
            call(&restored, "pairing_state", Value::Null).await,
            json!({"status": "ok", "data": {"hosts": 1, "key_changed": true}})
        );
    });
}
