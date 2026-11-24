//! What a build of the StatGlass core is: its version and the protocol range it speaks.
//!
//! The iPhone facade (`statglass-mobile`) returns it from `version()`; it lives here so
//! the app shell's specta export reaches it without an edge to the facade.

use serde::Serialize;

/// A build's crate version and the session protocol range it negotiates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct BuildInfo {
    /// The workspace version, for example `0.14.0`.
    pub version: String,
    /// The oldest protocol version this build still speaks.
    pub protocol_min: u16,
    /// The protocol version this build offers.
    pub protocol_max: u16,
}
