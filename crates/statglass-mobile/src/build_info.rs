//! What this build of the core is: its version and the protocol range it speaks.

use serde::Serialize;

/// The crate version and the session protocol range this build negotiates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BuildInfo {
    /// The workspace version, for example `0.14.0`.
    pub version: String,
    /// The oldest protocol version this build still speaks.
    pub protocol_min: u16,
    /// The protocol version this build offers.
    pub protocol_max: u16,
}

/// The build info of the running library.
pub(crate) fn current() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_min: statglass_proto::MIN_COMPATIBLE,
        protocol_max: statglass_proto::PROTO_VERSION,
    }
}
