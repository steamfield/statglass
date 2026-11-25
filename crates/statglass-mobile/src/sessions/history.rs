use statglass_ipc::{
    error::CommandError,
    mobile::{HostHistoryPage, HostHistoryRequest},
};

use super::registry::Registry;

impl Registry {
    pub(super) async fn host_history(
        &self,
        _request: HostHistoryRequest,
    ) -> Result<HostHistoryPage, CommandError> {
        Err(CommandError::RemoteUnsupported {
            message: "This host does not answer history queries".into(),
        })
    }
}
