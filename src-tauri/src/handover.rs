use std::sync::Arc;

use serde::Serialize;
use statglass_ipc::mobile::HandoverReasonInfo;
use statglass_remote::HandoverSource;
use statglass_schema::{HostId, JsSafeInt};
use tauri::State;

use crate::error::CommandError;

pub struct HandoverState;

impl HandoverState {
    pub(crate) fn source(&self) -> Option<Arc<dyn HandoverSource>> {
        None
    }
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct HandoverOffer {
    pub text: String,
    pub qr_svg: String,
    pub hosts: Vec<String>,
    pub unavailable: Vec<HandoverUnavailableInfo>,
    #[specta(type = JsSafeInt)]
    pub issued_ms: i64,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct HandoverUnavailableInfo {
    pub id: HostId,
    pub name: String,
    pub reason: HandoverReasonInfo,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct DeviceIntentInfo {
    pub host: HostId,
    pub host_name: String,
    pub device: String,
    pub device_name: String,
    pub op: String,
    pub state: String,
    pub reason: Option<String>,
    pub attempts: u32,
}

#[tauri::command]
#[specta::specta]
pub async fn handover_bundle_start(
    _state: State<'_, HandoverState>,
) -> Result<HandoverOffer, CommandError> {
    Err(CommandError::Handover {
        message: "Host handover is not implemented.".into(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn device_intents(
    _state: State<'_, HandoverState>,
) -> Result<Vec<DeviceIntentInfo>, CommandError> {
    Ok(Vec::new())
}

#[tauri::command]
#[specta::specta]
pub async fn retry_device_intents(_state: State<'_, HandoverState>) -> Result<(), CommandError> {
    Ok(())
}
