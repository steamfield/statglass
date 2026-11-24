//! The iPhone app's Rust core, exported to Swift through UniFFI proc macros.
//!
//! Every exported function returns the desktop command envelope as JSON
//! (`{"status":"ok","data":...}` or `{"status":"error","error":...}`) and runs its body
//! under [`std::panic::catch_unwind`], so a panic becomes an `internal` error instead of
//! unwinding into Swift. That needs the `mobile-release` Cargo profile
//! (`panic = "unwind"`); under the workspace release profile a panic aborts.
//!
//! This crate never depends on `statglass-remote` (`scripts/architecture/crate-edges.json`).

mod build_info;
mod envelope;

pub use build_info::BuildInfo;

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
