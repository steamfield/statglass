use statglass_ipc::mobile::DataPolicy;

use crate::ffi::NetworkPath;

#[expect(dead_code, reason = "demand will apply the live data policy")]
pub(crate) fn live_allowed(_path: Option<NetworkPath>, _data: DataPolicy) -> bool {
    true
}
