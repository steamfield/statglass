//! The Mac's pairing commands (RFC `plan/rfc-ios-app.md` 2.4, 2.5): offer a pairing QR,
//! follow it until the user approves or denies the phone on the sheet, and list or revoke
//! the phones paired with this Mac.
mod bundle;
mod helper_link;

use std::{
    path::Path,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use qrcode::{QrCode, render::svg};
use serde::Serialize;
use statglass_engine::wall_ms;
use statglass_proto::pairing::{BundleHost, PairReply, encode_payload};
use statglass_remote::{
    AuthorizedKeys, DeviceKeys, DeviceKeysError, DeviceSeenLog, DeviceTag, PairingError,
    PairingHost,
};
use statglass_schema::{HostRecord, JsSafeInt};
use tauri::State;

use crate::error::CommandError;

/// The local pairing host and its settings, initialized before the control socket starts.
#[derive(Default)]
pub struct PairingState {
    local: OnceLock<Arc<LocalPairing>>,
}

struct LocalPairing {
    record: HostRecord,
    enabled: AtomicBool,
    host: Result<PairingHost, String>,
    keys: Result<Arc<AuthorizedKeys>, String>,
    seen: DeviceSeenLog,
}

impl PairingState {
    pub(crate) fn initialize(&self, data_dir: &Path, record: HostRecord) {
        let commands = helper_link::install(data_dir).map_err(|error| format!("{error:#}"));
        let keys = AuthorizedKeys::for_current_user()
            .map(Arc::new)
            .map_err(|error| error.to_string());
        let host =
            commands.and_then(|commands| keys.clone().map(|keys| PairingHost::new(keys, commands)));
        if let Err(message) = &host {
            tracing::info!(%message, "iPhone pairing unavailable");
        }
        let local = LocalPairing {
            record,
            host,
            keys,
            enabled: AtomicBool::new(false),
            seen: device_seen(data_dir),
        };
        if self.local.set(Arc::new(local)).is_err() {
            tracing::warn!("iPhone pairing was already initialized");
        }
    }

    pub(crate) fn set_enabled(&self, enabled: bool) {
        if let Some(local) = self.local.get() {
            local.enabled.store(enabled, Ordering::Relaxed);
        }
    }

    pub(crate) fn host(&self) -> Option<&PairingHost> {
        self.local.get()?.host.as_ref().ok()
    }

    async fn run<T: Send + 'static>(
        &self,
        task: impl FnOnce(&LocalPairing) -> Result<T, CommandError> + Send + 'static,
    ) -> Result<T, CommandError> {
        let local = self
            .local
            .get()
            .cloned()
            .ok_or_else(|| pairing_message("iPhone pairing has not started."))?;
        tauri::async_runtime::spawn_blocking(move || task(&local))
            .await
            .map_err(|error| {
                pairing_message(format!("The pairing command could not finish. {error}"))
            })?
    }
}

pub(crate) fn device_seen(data_dir: &Path) -> DeviceSeenLog {
    DeviceSeenLog::new(data_dir.join("devices-seen.jsonl"))
}

impl LocalPairing {
    fn host(&self) -> Result<&PairingHost, CommandError> {
        self.host
            .as_ref()
            .map_err(|message| pairing_message(message.clone()))
    }

    fn keys(&self) -> Result<&AuthorizedKeys, CommandError> {
        self.keys
            .as_deref()
            .map_err(|message| pairing_message(message.clone()))
    }

    fn check_monitoring(&self) -> Result<(), CommandError> {
        bundle::check_monitoring(self.enabled.load(Ordering::Relaxed))
            .map_err(|error| pairing_message(error.to_string()))
    }

    fn start(&self) -> Result<PairingOffer, CommandError> {
        self.check_monitoring()?;
        let host = self.host()?;
        let bundle =
            bundle::build(&self.record).map_err(|error| pairing_message(format!("{error:#}")))?;
        self.check_monitoring()?;
        offer(host, bundle, wall_ms())
    }
}

fn offer(
    host: &PairingHost,
    bundle: BundleHost,
    now_ms: i64,
) -> Result<PairingOffer, CommandError> {
    host.expire(now_ms);
    let payload = host
        .offer(bundle, Duration::ZERO, now_ms)
        .map_err(pairing_error)?;
    let text = encode_payload(&payload);
    let qr = match QrCode::new(&text) {
        Ok(qr) => qr,
        Err(error) => {
            if let Err(cleanup) = host.cancel(&payload.nonce) {
                tracing::warn!(
                    error = &cleanup as &dyn std::error::Error,
                    "cleaning up an offer after QR generation failed"
                );
            }
            return Err(pairing_message(format!(
                "The pairing QR could not be generated. {error}"
            )));
        }
    };
    Ok(PairingOffer {
        nonce: payload.nonce,
        code: payload.code,
        qr_svg: qr.render::<svg::Color>().build(),
        text,
        expires_ms: payload.expires_ms,
    })
}

fn devices(
    keys: &AuthorizedKeys,
    seen: &DeviceSeenLog,
) -> Result<Vec<PairedDeviceInfo>, CommandError> {
    let seen = seen.read();
    Ok(keys
        .list_devices()
        .map_err(device_keys_error)?
        .into_iter()
        .map(|device| PairedDeviceInfo {
            tag: device.tag.to_string(),
            name: device.name,
            fingerprint: device.fingerprint,
            last_seen_ms: seen.get(&device.tag).copied(),
        })
        .collect())
}

/// One open pairing, as the sheet shows it.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct PairingOffer {
    pub nonce: String,
    /// The six-character code the phone shows back for the user to compare.
    pub code: String,
    /// The QR carrying the pairing payload, as an SVG document.
    pub qr_svg: String,
    /// The same payload as text, for pasting when the camera can't read the QR.
    pub text: String,
    #[specta(type = JsSafeInt)]
    pub expires_ms: i64,
}

/// Where an open pairing stands.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PairingStatus {
    /// No phone has used the QR yet.
    Waiting,
    /// A phone used the QR and waits for the user's approval.
    Pending {
        device_name: String,
        model: String,
        code: String,
    },
    /// Approved: `device` is the new device's tag.
    Paired {
        device: String,
    },
    Denied,
    Expired,
    Failed {
        message: String,
    },
}

/// One phone with a key in this Mac's `authorized_keys`.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct PairedDeviceInfo {
    pub tag: String,
    pub name: String,
    pub fingerprint: String,
    /// When the phone last connected; `None` when it never has.
    #[specta(type = Option<JsSafeInt>)]
    pub last_seen_ms: Option<i64>,
}

impl From<PairReply> for PairingStatus {
    fn from(reply: PairReply) -> Self {
        match reply {
            PairReply::Waiting => Self::Waiting,
            PairReply::Pending {
                device_name,
                model,
                code,
            } => Self::Pending {
                device_name,
                model,
                code,
            },
            PairReply::Approved { device, .. } => Self::Paired { device },
            PairReply::Denied => Self::Denied,
            PairReply::Expired => Self::Expired,
            PairReply::Error { error } => Self::Failed {
                message: error.to_string(),
            },
        }
    }
}

fn pairing_message(message: impl Into<String>) -> CommandError {
    CommandError::Pairing {
        message: message.into(),
    }
}

pub(crate) fn pairing_error(error: PairingError) -> CommandError {
    match error {
        PairingError::Keys(error) => device_keys_error(error),
        PairingError::Pair(error) => pairing_message(error.to_string()),
    }
}

pub(crate) fn device_keys_error(error: DeviceKeysError) -> CommandError {
    // The I/O error retains its source chain even when its Display is just the path and operation.
    pairing_message(format!(
        "Could not update or read paired devices. {:#}",
        anyhow::Error::new(error)
    ))
}

/// Opens a pairing offer and returns its QR. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_start(state: State<'_, PairingState>) -> Result<PairingOffer, CommandError> {
    state.run(LocalPairing::start).await
}

/// Where the offer `nonce` stands. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_status(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<PairingStatus, CommandError> {
    state
        .run(move |local| {
            let host = local.host()?;
            let mut reply = host.pending(&nonce, wall_ms());
            if matches!(reply, PairReply::Waiting | PairReply::Pending { .. })
                && !local.enabled.load(Ordering::Relaxed)
            {
                host.cancel(&nonce).map_err(pairing_error)?;
                reply = host.pending(&nonce, wall_ms());
            }
            Ok(reply.into())
        })
        .await
}

/// Approves the phone waiting on `nonce`. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_approve(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<PairingStatus, CommandError> {
    state
        .run(move |local| {
            let host = local.host()?;
            if let Err(error) = local.check_monitoring() {
                host.cancel(&nonce).map_err(pairing_error)?;
                return Err(error);
            }
            host.approve(&nonce, wall_ms())
                .map(Into::into)
                .map_err(pairing_error)
        })
        .await
}

/// Denies the phone waiting on `nonce`. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_deny(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<(), CommandError> {
    state
        .run(move |local| local.host()?.deny(&nonce).map_err(pairing_error))
        .await
}

/// Withdraws the offer `nonce`. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_cancel(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<(), CommandError> {
    state
        .run(move |local| local.host()?.cancel(&nonce).map_err(pairing_error))
        .await
}

/// The phones paired with this Mac. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn paired_devices(
    state: State<'_, PairingState>,
) -> Result<Vec<PairedDeviceInfo>, CommandError> {
    state.run(|local| devices(local.keys()?, &local.seen)).await
}

/// Removes the device `tag`; false when no device has it. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn revoke_device(
    tag: String,
    state: State<'_, PairingState>,
) -> Result<bool, CommandError> {
    let tag =
        DeviceTag::parse(&tag).ok_or_else(|| pairing_message("Invalid paired device tag."))?;
    state
        .run(move |local| local.keys()?.revoke(tag).map_err(device_keys_error))
        .await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use statglass_proto::pairing::{BundleRoute, BundleTarget, PairStart, decode_payload};
    use statglass_remote::{EcdsaP256Public, PairCommands};
    use statglass_schema::{HostId, HostInfo, OsKind};
    use tauri::{
        Manager,
        test::{MockRuntime, mock_builder, mock_context, noop_assets},
    };

    // SEC1 encoding of the P-256 generator.
    pub(crate) const DEVICE_KEY: [u8; 65] = [
        4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125,
        129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26,
        127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182,
        64, 104, 55, 191, 81, 245,
    ];

    pub(crate) fn app(dir: &Path) -> tauri::App<MockRuntime> {
        let keys = Arc::new(AuthorizedKeys::at(dir.join("authorized_keys")));
        let record = HostRecord {
            id: HostId(uuid::Uuid::nil()),
            is_local: true,
            display_name: "Test Mac".into(),
            info: HostInfo {
                os: OsKind::MacOs,
                os_version: "26.0".into(),
                model: None,
                chip: None,
                chip_known: false,
                cpu_topology: vec![],
                mem_total_bytes: 0,
                boot_time_ms: 0,
                gpu_dvfs_mhz: vec![],
                boot_mounts: vec![],
                kernel: None,
            },
        };
        let host = PairingHost::new(
            keys.clone(),
            PairCommands {
                pair: "/helper pair".into(),
                restricted: "/helper restricted".into(),
            },
        );
        let local = LocalPairing {
            record,
            host: Ok(host),
            keys: Ok(keys),
            enabled: AtomicBool::new(false),
            seen: device_seen(dir),
        };
        mock_builder()
            .manage(PairingState {
                local: OnceLock::from(Arc::new(local)),
            })
            .build(mock_context(noop_assets()))
            .unwrap()
    }

    #[tokio::test]
    async fn pairing_commands_show_host_decisions_and_merge_seen_devices() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let state = app.state::<PairingState>();
        assert!(
            matches!(pairing_start(app.state()).await, Err(CommandError::Pairing { message })
            if message.contains("Allow remote monitoring"))
        );
        assert!(paired_devices(app.state()).await.unwrap().is_empty());
        state.set_enabled(true);
        assert!(matches!(
            revoke_device("invalid".into(), app.state()).await,
            Err(CommandError::Pairing { .. })
        ));

        let host = state.host().unwrap();
        let bundle = BundleHost {
            host_id: HostId(uuid::Uuid::nil()),
            name: "Test Mac".into(),
            os: "macOS 26.0".into(),
            user: "test".into(),
            port: None,
            targets: vec![BundleTarget {
                route: BundleRoute::Lan,
                host: "test.local".into(),
            }],
            host_keys: vec![],
        };
        let now = wall_ms();
        let make_offer = |now| offer(host, bundle.clone(), now).unwrap();
        let first = make_offer(now);
        assert!(first.qr_svg.contains("<svg"));
        assert!(first.text.len() < 1200);
        let decoded = decode_payload(&first.text, now).unwrap();
        assert_eq!(decoded.host, bundle);
        assert_eq!(decoded.code, first.code);
        assert_eq!(decoded.expires_ms, first.expires_ms);
        assert_eq!(decoded.nonce, first.nonce);

        let start = |nonce: &str| {
            host.start(
                &PairStart {
                    nonce: nonce.into(),
                    device_name: "Travel iPhone".into(),
                    model: "iPhone 16".into(),
                    device_key: DEVICE_KEY.into(),
                },
                now,
            )
        };
        assert!(matches!(
            pairing_status(first.nonce.clone(), app.state())
                .await
                .unwrap(),
            PairingStatus::Waiting
        ));
        assert_eq!(start(&first.nonce), PairReply::Waiting);
        assert!(
            matches!(pairing_status(first.nonce.clone(), app.state()).await.unwrap(),
            PairingStatus::Pending { device_name, model, code } if
            device_name == "Travel iPhone" && model == "iPhone 16" && code == first.code)
        );
        let tag = DeviceTag::from_key(&EcdsaP256Public(DEVICE_KEY));
        assert!(
            matches!(pairing_approve(first.nonce.clone(), app.state()).await.unwrap(),
            PairingStatus::Paired { device } if device == tag.to_string())
        );
        assert!(
            matches!(pairing_status(first.nonce, app.state()).await.unwrap(),
            PairingStatus::Paired { device } if device == tag.to_string())
        );
        device_seen(dir.path()).record(tag, now - 1);
        device_seen(dir.path()).record(tag, now - 10);
        let devices = paired_devices(app.state()).await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].tag, tag.to_string());
        assert_eq!(devices[0].name, "Travel iPhone");
        assert_eq!(devices[0].last_seen_ms, Some(now - 1));
        assert!(devices[0].fingerprint.starts_with("SHA256:"));
        assert!(revoke_device(tag.to_string(), app.state()).await.unwrap());
        assert!(!revoke_device(tag.to_string(), app.state()).await.unwrap());
        assert!(paired_devices(app.state()).await.unwrap().is_empty());

        let denied = make_offer(now);
        assert_eq!(start(&denied.nonce), PairReply::Waiting);
        pairing_deny(denied.nonce.clone(), app.state())
            .await
            .unwrap();
        assert!(matches!(
            pairing_status(denied.nonce, app.state()).await.unwrap(),
            PairingStatus::Denied
        ));
        let cancelled = make_offer(now);
        pairing_cancel(cancelled.nonce.clone(), app.state())
            .await
            .unwrap();
        assert!(matches!(
            pairing_status(cancelled.nonce, app.state()).await.unwrap(),
            PairingStatus::Denied
        ));
        let expired = make_offer(now - 601_000);
        assert!(matches!(
            pairing_status(expired.nonce, app.state()).await.unwrap(),
            PairingStatus::Expired
        ));
        assert!(
            std::fs::read_to_string(dir.path().join("authorized_keys"))
                .unwrap()
                .is_empty()
        );

        let withdrawn = make_offer(now);
        assert_eq!(start(&withdrawn.nonce), PairReply::Waiting);
        state.set_enabled(false);
        assert!(matches!(
            pairing_approve(withdrawn.nonce.clone(), app.state()).await,
            Err(CommandError::Pairing { message }) if message.contains("Allow remote monitoring")
        ));
        assert!(matches!(
            pairing_status(withdrawn.nonce, app.state()).await.unwrap(),
            PairingStatus::Denied
        ));
        assert!(paired_devices(app.state()).await.unwrap().is_empty());
    }
}
