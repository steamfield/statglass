//! The Mac's pairing commands (RFC `plan/rfc-ios-app.md` 2.4, 2.5): offer a pairing QR,
//! follow it until the user approves or denies the phone on the sheet, and list or revoke
//! the phones paired with this Mac.
mod bundle;
mod helper_link;
mod status;

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

use qrcode::{QrCode, render::svg};
use statglass_engine::wall_ms;
use statglass_proto::pairing::{BundleHost, encode_payload};
use statglass_remote::{
    AuthorizedKeys, ControlRequest, ControlResponse, DeviceKeys, DeviceSeenLog, DeviceTag,
    HandoverSource, PairingHost,
};
use statglass_schema::{HostRecord, lock::LockExt};
use tauri::State;

use crate::error::{CommandError, PairingFailure};
use crate::handover::HandoverState;
pub use status::{PairedDeviceInfo, PairingOffer, PairingStatus};
use status::{
    device_keys_error, monitoring_off_status, pairing_error, pairing_message, unavailable,
};

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
    monitoring_off: Mutex<HashMap<String, i64>>,
    key_edits: Mutex<()>,
}

impl PairingState {
    pub(crate) fn initialize(
        &self,
        data_dir: &Path,
        record: HostRecord,
        handover: Option<Arc<dyn HandoverSource>>,
    ) {
        let commands = helper_link::install(data_dir).map_err(|error| format!("{error:#}"));
        let keys = AuthorizedKeys::for_current_user()
            .map(Arc::new)
            .map_err(|error| error.to_string());
        let host =
            commands.and_then(|commands| keys.clone().map(|keys| PairingHost::new(keys, commands)));
        if let (Ok(host), Some(source)) = (&host, handover) {
            host.set_handover(source);
        }
        if let Err(message) = &host {
            tracing::info!(%message, "iPhone pairing unavailable");
        }
        let local = LocalPairing {
            record,
            host,
            keys,
            enabled: AtomicBool::new(false),
            seen: device_seen(data_dir),
            monitoring_off: Mutex::default(),
            key_edits: Mutex::default(),
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

    #[cfg(test)]
    pub(crate) fn host(&self) -> Option<&PairingHost> {
        self.local.get()?.host.as_ref().ok()
    }

    pub(crate) fn control_reply(
        &self,
        request: ControlRequest,
        now_ms: i64,
    ) -> Option<ControlResponse> {
        let local = self.local.get()?;
        let host = local.host.as_ref().ok()?;
        Some(host.control_reply(request, now_ms))
    }

    pub(crate) fn shutdown(&self) {
        if let Some(local) = self.local.get()
            && let Ok(host) = &local.host
        {
            host.cancel_open(wall_ms());
        }
    }

    async fn run<T: Send + 'static>(
        &self,
        task: impl FnOnce(&LocalPairing) -> Result<T, CommandError> + Send + 'static,
    ) -> Result<T, CommandError> {
        let local = self
            .local
            .get()
            .cloned()
            .ok_or_else(|| unavailable("iPhone pairing has not started."))?;
        tauri::async_runtime::spawn_blocking(move || task(&local))
            .await
            .map_err(|error| {
                unavailable(format!("The pairing command could not finish. {error}"))
            })?
    }

    pub(crate) async fn with_device_keys<T: Send + 'static>(
        &self,
        task: impl FnOnce(&AuthorizedKeys) -> Result<T, CommandError> + Send + 'static,
    ) -> Result<T, CommandError> {
        self.run(move |local| {
            let _edit = local.key_edits.lock_ok();
            task(local.keys()?)
        })
        .await
    }
}

pub(crate) fn device_seen(data_dir: &Path) -> DeviceSeenLog {
    DeviceSeenLog::new(data_dir.join("devices-seen.jsonl"))
}

impl LocalPairing {
    fn host(&self) -> Result<&PairingHost, CommandError> {
        self.host
            .as_ref()
            .map_err(|message| unavailable(message.clone()))
    }

    fn keys(&self) -> Result<&AuthorizedKeys, CommandError> {
        self.keys
            .as_deref()
            .map_err(|message| unavailable(message.clone()))
    }

    fn check_monitoring(&self) -> Result<(), CommandError> {
        bundle::check_monitoring(self.enabled.load(Ordering::Relaxed))
            .map_err(|error| pairing_message(PairingFailure::MonitoringOff, error.to_string()))
    }

    fn start(&self) -> Result<PairingOffer, CommandError> {
        self.check_monitoring()?;
        self.host()?;
        let bundle =
            bundle::build(&self.record).map_err(|error| unavailable(format!("{error:#}")))?;
        self.offer(bundle, wall_ms())
    }

    fn offer(&self, bundle: BundleHost, now_ms: i64) -> Result<PairingOffer, CommandError> {
        self.check_monitoring()?;
        let host = self.host()?;
        host.expire(now_ms);
        self.monitoring_off
            .lock_ok()
            .retain(|_, deadline| *deadline > now_ms);
        let payload = bundle::offer(host, bundle, now_ms).map_err(pairing_error)?;
        let text = encode_payload(&payload);
        let qr = match QrCode::new(&text) {
            Ok(qr) => qr,
            Err(error) => {
                if let Err(cleanup) = host.cancel(&payload.nonce) {
                    tracing::warn!(
                        error = &cleanup as &dyn std::error::Error,
                        "removing a pairing key after QR generation failed"
                    );
                }
                return Err(unavailable(format!(
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

    fn decision(&self, nonce: &str, approve: bool) -> Result<PairingStatus, CommandError> {
        let _edit = approve.then(|| self.key_edits.lock_ok());
        let mut monitoring_off = self.monitoring_off.lock_ok();
        if monitoring_off.contains_key(nonce) {
            return Ok(monitoring_off_status());
        }
        let host = self.host()?;
        let now_ms = wall_ms();
        if !self.enabled.load(Ordering::Relaxed) {
            let (reply, deadline) = host.withdraw_if_open(nonce, now_ms);
            if let Some(deadline) = deadline {
                monitoring_off.insert(nonce.into(), deadline);
                return Ok(monitoring_off_status());
            }
            return Ok(reply.into());
        }
        let reply = if approve {
            host.approve(nonce, now_ms).map_err(pairing_error)?
        } else {
            host.pending(nonce, now_ms)
        };
        Ok(reply.into())
    }

    fn deny(&self, nonce: &str) -> Result<PairingStatus, CommandError> {
        let monitoring_off = self.monitoring_off.lock_ok();
        let reply = self.host()?.deny(nonce).map_err(pairing_error)?;
        Ok(if monitoring_off.contains_key(nonce) {
            monitoring_off_status()
        } else {
            reply.into()
        })
    }
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

/// Opens a pairing offer and returns its QR.
///
/// # Errors
///
/// Returns `pairing` if preflight, key installation, or QR generation fails, or the app is quitting.
#[tauri::command]
#[specta::specta]
pub async fn pairing_start(state: State<'_, PairingState>) -> Result<PairingOffer, CommandError> {
    state.run(LocalPairing::start).await
}

/// Where the offer `nonce` stands.
///
/// # Errors
///
/// Returns `pairing` if the pairing host or command worker is unavailable.
#[tauri::command]
#[specta::specta]
pub async fn pairing_status(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<PairingStatus, CommandError> {
    state.run(move |local| local.decision(&nonce, false)).await
}

/// Approves the phone waiting on `nonce`.
///
/// # Errors
///
/// Returns `pairing` if the host or worker is unavailable, the offer is unknown or
/// still waiting for a phone, or a key edit fails.
#[tauri::command]
#[specta::specta]
pub async fn pairing_approve(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<PairingStatus, CommandError> {
    state.run(move |local| local.decision(&nonce, true)).await
}

/// Denies the phone waiting on `nonce` and returns the offer's resulting status.
///
/// # Errors
///
/// Returns `pairing` if the host or worker is unavailable, the offer is unknown,
/// or the pairing line cannot be removed.
#[tauri::command]
#[specta::specta]
pub async fn pairing_deny(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<PairingStatus, CommandError> {
    state.run(move |local| local.deny(&nonce)).await
}

/// Withdraws the offer `nonce`.
///
/// # Errors
///
/// Returns `pairing` if the host or worker is unavailable, the offer is unknown,
/// or the pairing line cannot be removed.
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

/// The phones paired with this Mac.
///
/// # Errors
///
/// Returns `pairing` if the command worker or authorized keys file cannot be readied.
#[tauri::command]
#[specta::specta]
pub async fn paired_devices(
    state: State<'_, PairingState>,
) -> Result<Vec<PairedDeviceInfo>, CommandError> {
    state.run(|local| devices(local.keys()?, &local.seen)).await
}

/// Removes the device `tag`. Returns false when no device has it.
///
/// # Errors
///
/// Returns `pairing` if the tag is invalid, the command worker is unavailable,
/// or the authorized keys file cannot be edited.
#[tauri::command]
#[specta::specta]
pub async fn revoke_device(
    tag: String,
    state: State<'_, PairingState>,
    handover: State<'_, HandoverState>,
) -> Result<bool, CommandError> {
    let tag = DeviceTag::parse(&tag)
        .ok_or_else(|| pairing_message(PairingFailure::Invalid, "Invalid paired device tag."))?;
    let handover = handover.inner().clone();
    state
        .with_device_keys(move |keys| {
            let removed = keys.revoke(tag).map_err(device_keys_error)?;
            handover.record_revocations(tag)?;
            Ok(removed)
        })
        .await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use statglass_proto::pairing::{
        BundleRoute, BundleTarget, PairReply, PairStart, decode_payload,
    };
    use statglass_remote::{ControlRequest, EcdsaP256Public, PairCommands};
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
            monitoring_off: Mutex::default(),
            key_edits: Mutex::default(),
        };
        mock_builder()
            .manage(HandoverState::default())
            .manage(PairingState {
                local: OnceLock::from(Arc::new(local)),
            })
            .build(mock_context(noop_assets()))
            .unwrap()
    }

    #[test]
    fn pairing_shutdown_withdraws_open_offers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("authorized_keys");
        let app = app(dir.path());
        let state = app.state::<PairingState>();
        state.set_enabled(true);
        let local = state.local.get().unwrap();
        let now = wall_ms();
        let bundle = BundleHost {
            host_id: HostId(uuid::Uuid::nil()),
            name: "Test Mac".into(),
            os: "macOS 26.0".into(),
            user: "test".into(),
            port: None,
            targets: vec![],
            host_keys: vec![],
        };
        let pending = local.offer(bundle.clone(), now).unwrap();
        let waiting = local.offer(bundle.clone(), now).unwrap();
        let reply = state
            .control_reply(
                ControlRequest::PairStart {
                    start: PairStart {
                        nonce: pending.nonce.clone(),
                        device_name: "Travel iPhone".into(),
                        model: "iPhone 16".into(),
                        device_key: DEVICE_KEY.into(),
                    },
                    attempt: [1; 16],
                },
                now,
            )
            .unwrap();
        assert_eq!(reply.pairing, Some(PairReply::Waiting));
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("statglass-pairing:")
        );

        state.shutdown();

        assert!(std::fs::read_to_string(&path).unwrap().is_empty());
        assert!(matches!(
            local.offer(bundle, now),
            Err(CommandError::Pairing { .. })
        ));
        assert!(std::fs::read_to_string(path).unwrap().is_empty());
        for nonce in [pending.nonce, waiting.nonce] {
            let reply = state
                .control_reply(ControlRequest::PairStatus { nonce }, now)
                .unwrap();
            assert!(matches!(
                reply.pairing,
                Some(PairReply::Denied | PairReply::Expired)
            ));
        }
    }

    #[tokio::test]
    async fn pairing_commands_show_host_decisions_and_merge_seen_devices() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let state = app.state::<PairingState>();
        assert!(
            matches!(pairing_start(app.state()).await, Err(CommandError::Pairing { reason: PairingFailure::MonitoringOff, message })
            if message.contains("Allow remote monitoring"))
        );
        assert!(paired_devices(app.state()).await.unwrap().is_empty());
        state.set_enabled(true);
        assert!(matches!(
            revoke_device("invalid".into(), app.state(), app.state()).await,
            Err(CommandError::Pairing { .. })
        ));

        let host = state.host().unwrap();
        let local = state.local.get().unwrap();
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
        let make_offer = |now| local.offer(bundle.clone(), now).unwrap();
        let first = make_offer(now);
        assert!(first.qr_svg.contains("<svg"));
        assert!(first.text.len() < 1200);
        let decoded = decode_payload(&first.text, now).unwrap();
        assert_eq!(decoded.host, bundle);
        assert_eq!(decoded.code, first.code);
        assert_eq!(decoded.expires_ms, first.expires_ms);
        assert_eq!(decoded.nonce, first.nonce);

        let start = |nonce: &str| {
            host.control_reply(
                ControlRequest::PairStart {
                    start: PairStart {
                        nonce: nonce.into(),
                        device_name: "Travel iPhone".into(),
                        model: "iPhone 16".into(),
                        device_key: DEVICE_KEY.into(),
                    },
                    attempt: [1; 16],
                },
                now,
            )
            .pairing
            .unwrap()
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
            PairingStatus::Paired { device, .. } if device == tag.to_string())
        );
        assert!(
            matches!(pairing_status(first.nonce, app.state()).await.unwrap(),
            PairingStatus::Paired { device, .. } if device == tag.to_string())
        );
        device_seen(dir.path()).record(tag, now - 1);
        device_seen(dir.path()).record(tag, now - 10);
        let devices = paired_devices(app.state()).await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].tag, tag.to_string());
        assert_eq!(devices[0].name, "Travel iPhone");
        assert_eq!(devices[0].last_seen_ms, Some(now - 1));
        assert!(devices[0].fingerprint.starts_with("SHA256:"));
        assert!(
            revoke_device(tag.to_string(), app.state(), app.state())
                .await
                .unwrap()
        );
        assert!(
            !revoke_device(tag.to_string(), app.state(), app.state())
                .await
                .unwrap()
        );
        assert!(paired_devices(app.state()).await.unwrap().is_empty());

        let denied = make_offer(now);
        assert_eq!(start(&denied.nonce), PairReply::Waiting);
        assert!(matches!(
            pairing_deny(denied.nonce.clone(), app.state())
                .await
                .unwrap(),
            PairingStatus::Denied
        ));
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

        for approve_first in [false, true] {
            state.set_enabled(true);
            let withdrawn = make_offer(now);
            assert_eq!(start(&withdrawn.nonce), PairReply::Waiting);
            state.set_enabled(false);
            let result = if approve_first {
                pairing_approve(withdrawn.nonce.clone(), app.state()).await
            } else {
                pairing_status(withdrawn.nonce.clone(), app.state()).await
            };
            let guidance = bundle::check_monitoring(false).unwrap_err().to_string();
            assert!(
                matches!(result, Ok(PairingStatus::Failed { reason: PairingFailure::MonitoringOff, message }) if message == guidance)
            );
            assert_eq!(host.status(&withdrawn.nonce, now), PairReply::Denied);
            state.set_enabled(true);
            assert!(matches!(
                pairing_status(withdrawn.nonce, app.state()).await.unwrap(),
                PairingStatus::Failed { reason: PairingFailure::MonitoringOff, message } if message == guidance
            ));
        }
        assert!(paired_devices(app.state()).await.unwrap().is_empty());
    }
}
