use statglass_ipc::{
    error::CommandError,
    mobile::{BundleReconcile, OfferedHost},
};

use crate::sessions::Sessions;

pub(crate) fn decode_bundle(
    _sessions: &Sessions,
    _text: &str,
) -> Result<BundleReconcile, CommandError> {
    Err(CommandError::Internal {
        message: "Host bundle decoding is not implemented.".into(),
    })
}

pub(crate) fn add_handover_hosts(
    _sessions: &Sessions,
    _hosts: Vec<OfferedHost>,
) -> Result<(), CommandError> {
    Err(CommandError::Internal {
        message: "Adding handed-over hosts is not implemented.".into(),
    })
}
