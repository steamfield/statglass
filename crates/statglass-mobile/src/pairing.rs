use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{PairedHost, PairingPreview, PairingState};

use crate::sessions::Sessions;

pub(crate) fn preview(_text: &str, _now_ms: i64) -> Result<PairingPreview, CommandError> {
    Err(CommandError::Internal {
        message: "Pairing preview is not implemented".into(),
    })
}

pub(crate) async fn pair(
    _sessions: &Sessions,
    _device_key: Vec<u8>,
    _text: String,
    _device_name: String,
    _model: String,
) -> Result<PairedHost, CommandError> {
    Err(CommandError::Internal {
        message: "Pairing is not implemented".into(),
    })
}

pub(crate) fn state(_sessions: &Sessions) -> PairingState {
    PairingState {
        hosts: 0,
        key_changed: false,
    }
}
