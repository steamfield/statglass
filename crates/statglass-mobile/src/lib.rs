//! The iPhone app's Rust core, exported to Swift through UniFFI proc macros.
//!
//! Every exported function returns the desktop command envelope as JSON
//! (`{"status":"ok","data":...}` or `{"status":"error","error":CommandError}`) and runs
//! its body under [`std::panic::catch_unwind`] (or on the core's runtime, which catches
//! a task's panic), so a panic becomes an `internal` error instead of unwinding into
//! Swift. That needs the `mobile-release` Cargo profile (`panic = "unwind"`); under the
//! workspace release profile a panic aborts.
//!
//! Swift holds one [`MobileCore`]: commands go through [`MobileCore::call`] as a
//! `statglass_ipc::mobile::MobileCall`, live messages and events come back through
//! [`CoreEvents`], signing goes out through [`NativeSigner`], and the app's lifecycle
//! arrives as `quiesce`, `resume` and `path_changed`.
//!
//! This crate never depends on `statglass-remote` (`scripts/architecture/crate-edges.json`).

mod build_info;
mod control;
mod envelope;
#[cfg(test)]
mod facade_tests;
mod ffi;
mod handover;
mod host_store;
mod lifecycle;
mod logging;
mod mobile_core;
mod pairing;
mod policy;
mod sessions;
mod signer;

pub use crate::ffi::{CoreEvents, NativeSigner, NativeSignerError, NetworkPath};
pub use crate::mobile_core::MobileCore;
// The result type lives in schema so the app shell's specta export reaches it.
pub use statglass_schema::BuildInfo;

uniffi::setup_scaffolding!();

/// Returns this build's crate version and supported protocol range as a JSON envelope.
///
/// On success the envelope's `data` is a [`BuildInfo`].
///
/// # Errors
///
/// A panic while building the answer arrives as an error envelope with
/// `{"kind":"internal","message":...}` instead of unwinding into Swift.
#[uniffi::export]
pub fn version() -> String {
    envelope::run(build_info::current)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    #[test]
    fn version_reports_the_crate_version_and_protocol_range() {
        let envelope: Value =
            serde_json::from_str(&super::version()).expect("the envelope is valid JSON");
        assert_eq!(
            envelope,
            json!({
                "status": "ok",
                "data": {
                    "version": env!("CARGO_PKG_VERSION"),
                    "protocol_min": statglass_proto::MIN_COMPATIBLE,
                    "protocol_max": statglass_proto::PROTO_VERSION,
                },
            })
        );
    }
}
