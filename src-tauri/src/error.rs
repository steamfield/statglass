//! The error every command returns. It lives in `statglass-ipc`, shared with the phone;
//! this module keeps the `crate::error` path the shell's commands import it from.
pub use statglass_ipc::error::*;
