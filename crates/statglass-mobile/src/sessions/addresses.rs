use statglass_ipc::{error::CommandError, mobile::HostAddressesInfo};
use statglass_schema::HostId;

use super::registry::Registry;

impl Registry {
    pub(super) async fn network_addresses(
        &self,
        _host: HostId,
    ) -> Result<HostAddressesInfo, CommandError> {
        Err(CommandError::RemoteUnsupported {
            message: "Addresses are not available from this host".into(),
        })
    }
}
