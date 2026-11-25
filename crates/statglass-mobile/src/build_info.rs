//! What this build of the core is: its version and the protocol range it speaks.

use statglass_schema::BuildInfo;

/// The build info of the running library.
pub(crate) fn current() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_min: statglass_proto::MIN_COMPATIBLE,
        protocol_max: statglass_proto::PROTO_VERSION,
    }
}
