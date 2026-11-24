//! Host-side UniFFI bindings generator for this crate, run by
//! `scripts/mobile/build-rust-ios.sh` to write the Swift bindings.

fn main() {
    uniffi::uniffi_bindgen_main();
}
