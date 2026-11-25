//! The Mac's pairing commands (RFC `plan/rfc-ios-app.md` 2.4, 2.5): offer a pairing QR,
//! follow it until the user approves or denies the phone on the sheet, and list or revoke
//! the phones paired with this Mac.
//!
//! Scaffold: phase 5 lane c implements the state and every command; until then each
//! command fails with `CommandError::Pairing`.

use serde::Serialize;
use statglass_remote::{DeviceKeysError, PairingError};
use statglass_schema::JsSafeInt;
use tauri::State;

use crate::error::CommandError;

/// The pairing offers this Mac has open. Scaffold: holds nothing until phase 5 lane c.
#[derive(Default)]
pub struct PairingState {}

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
#[expect(dead_code, reason = "phase 5 lane c reports each state")]
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

/// A pairing failure as the command error the sheet shows. A function, not a `From`
/// impl: the orphan rule keeps `From` next to `CommandError` in `statglass-ipc`, which
/// must not depend on `statglass-remote`.
#[expect(
    dead_code,
    reason = "phase 5 lane c maps the pairing host's errors through it"
)]
pub(crate) fn pairing_error(error: PairingError) -> CommandError {
    CommandError::Pairing {
        message: error.to_string(),
    }
}

/// An `authorized_keys` failure as the command error the devices list shows.
#[expect(dead_code, reason = "phase 5 lane c maps device-key errors through it")]
pub(crate) fn device_keys_error(error: DeviceKeysError) -> CommandError {
    CommandError::Pairing {
        message: error.to_string(),
    }
}

/// The error every scaffold command returns until phase 5 lane c implements it.
fn not_implemented() -> CommandError {
    CommandError::Pairing {
        message: "not implemented".into(),
    }
}

/// Opens a pairing offer and returns its QR. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_start(state: State<'_, PairingState>) -> Result<PairingOffer, CommandError> {
    let _ = state;
    Err(not_implemented())
}

/// Where the offer `nonce` stands. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_status(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<PairingStatus, CommandError> {
    let _ = (nonce, state);
    Err(not_implemented())
}

/// Approves the phone waiting on `nonce`. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_approve(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<PairingStatus, CommandError> {
    let _ = (nonce, state);
    Err(not_implemented())
}

/// Denies the phone waiting on `nonce`. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_deny(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<(), CommandError> {
    let _ = (nonce, state);
    Err(not_implemented())
}

/// Withdraws the offer `nonce`. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn pairing_cancel(
    nonce: String,
    state: State<'_, PairingState>,
) -> Result<(), CommandError> {
    let _ = (nonce, state);
    Err(not_implemented())
}

/// The phones paired with this Mac. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn paired_devices(
    state: State<'_, PairingState>,
) -> Result<Vec<PairedDeviceInfo>, CommandError> {
    let _ = state;
    Err(not_implemented())
}

/// Removes the device `tag`; false when no device has it. Scaffold stub (phase 5 lane c).
#[tauri::command]
#[specta::specta]
pub async fn revoke_device(
    tag: String,
    state: State<'_, PairingState>,
) -> Result<bool, CommandError> {
    let _ = (tag, state);
    Err(not_implemented())
}
