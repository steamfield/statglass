use crate::error::{CommandError, PairingFailure};
use serde::Serialize;
use statglass_proto::pairing::PairReply;
use statglass_remote::{DeviceKeysError, PairingError, PairingHost};
use statglass_schema::JsSafeInt;

use super::bundle::MONITORING_OFF;
use crate::handover::HandoverUnavailableInfo;

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
    /// Approved: `device` is the new device's tag. The rest is what this Mac handed over
    /// with the approval, kept on the Mac (never on the wire): `hosts` names the remote hosts
    /// sent to the phone (never this Mac), `unavailable` the ones that could not be, and
    /// `dropped` is true when the list did not fit the reply and the phone got this Mac alone.
    Paired {
        device: String,
        hosts: Vec<String>,
        unavailable: Vec<HandoverUnavailableInfo>,
        dropped: bool,
    },
    Denied,
    Expired,
    Failed {
        reason: PairingFailure,
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

impl PairingStatus {
    pub(super) fn from_reply(reply: PairReply, host: &PairingHost, nonce: &str) -> Self {
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
            PairReply::Approved { device, .. } => {
                let (hosts, unavailable, dropped) = host
                    .handover_summary(nonce)
                    .map(|summary| {
                        (
                            summary
                                .handover
                                .hosts
                                .iter()
                                .map(|host| host.name.clone())
                                .collect(),
                            summary
                                .handover
                                .unavailable
                                .iter()
                                .cloned()
                                .map(Into::into)
                                .collect(),
                            summary.dropped,
                        )
                    })
                    .unwrap_or_default();
                Self::Paired {
                    device,
                    hosts,
                    unavailable,
                    dropped,
                }
            }
            PairReply::Denied => Self::Denied,
            PairReply::Expired => Self::Expired,
            PairReply::Error { error } => Self::Failed {
                reason: error.into(),
                message: error.to_string(),
            },
        }
    }
}

pub(super) fn monitoring_off_status() -> PairingStatus {
    PairingStatus::Failed {
        reason: PairingFailure::MonitoringOff,
        message: MONITORING_OFF.into(),
    }
}

pub(super) fn pairing_message(reason: PairingFailure, message: impl Into<String>) -> CommandError {
    CommandError::Pairing {
        reason,
        message: message.into(),
    }
}

pub(super) fn unavailable(message: impl Into<String>) -> CommandError {
    pairing_message(PairingFailure::Unavailable, message)
}

pub(super) fn pairing_error(error: PairingError) -> CommandError {
    match error {
        PairingError::Keys(error) => device_keys_error(error),
        PairingError::Pair(error) => pairing_message(error.into(), error.to_string()),
        PairingError::Closing => unavailable(error.to_string()),
    }
}

pub(super) fn device_keys_error(error: DeviceKeysError) -> CommandError {
    // The I/O error retains its source chain even when its Display is just the path and operation.
    unavailable(format!(
        "Could not update or read paired devices. {:#}",
        anyhow::Error::new(error)
    ))
}
