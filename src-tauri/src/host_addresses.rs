use statglass_ipc::mobile::HostAddressesInfo;
use statglass_schema::HostId;
use tauri::State;

use crate::error::CommandError;
use crate::state::AppState;

/// The monitored host's local and public addresses.
#[tauri::command]
#[specta::specta]
pub async fn get_host_addresses(
    state: State<'_, AppState>,
    host: HostId,
) -> Result<HostAddressesInfo, CommandError> {
    let _ = (state, host);
    Err(CommandError::RemoteUnsupported {
        message: "Host addresses are not available".into(),
    })
}
