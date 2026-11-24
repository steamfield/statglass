#!/usr/bin/env bash
# Builds the iPhone app's Rust core: statglass-mobile static libraries for device and
# Apple Silicon simulator (mobile-release profile, which unwinds on panic so the FFI
# guard can catch it), Swift bindings from UniFFI, and the XCFramework the Expo native
# module links. Outputs are generated and git-ignored:
#   apps/mobile/modules/statglass-native/ios/StatglassCore.xcframework
#   apps/mobile/modules/statglass-native/ios/generated/statglass_mobile.swift
set -euo pipefail

readonly CRATE=statglass-mobile
readonly LIB_NAME=libstatglass_mobile.a
readonly PROFILE=mobile-release
readonly DEVICE_TARGET=aarch64-apple-ios
readonly SIM_TARGET=aarch64-apple-ios-sim
readonly NATIVE_DIR=apps/mobile/modules/statglass-native/ios
readonly XCFRAMEWORK="$NATIVE_DIR/StatglassCore.xcframework"
readonly SWIFT_DIR="$NATIVE_DIR/generated"

fail() {
	echo "build-rust-ios: $*" >&2
	exit 1
}

cd "$(dirname "$0")/../.."

command -v xcodebuild >/dev/null || fail "xcodebuild not found; install Xcode (not only the Command Line Tools)"
command -v jq >/dev/null || fail "jq not found; install it with: brew install jq"
for target in "$DEVICE_TARGET" "$SIM_TARGET"; do
	rustup target list --installed | grep -qx "$target" ||
		fail "Rust target $target is not installed; run: rustup target add $target"
done

target_dir=$(cargo metadata --format-version 1 --no-deps | jq -r .target_directory) ||
	fail "cargo metadata failed; cannot find the target directory"

for target in "$DEVICE_TARGET" "$SIM_TARGET"; do
	cargo build --lib --profile "$PROFILE" --target "$target" -p "$CRATE" ||
		fail "cargo build of $CRATE failed for $target"
done
device_lib="$target_dir/$DEVICE_TARGET/$PROFILE/$LIB_NAME"
sim_lib="$target_dir/$SIM_TARGET/$PROFILE/$LIB_NAME"

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

# Library mode reads the exported interface from the built library's metadata, so the
# bindings always match the code that was just compiled.
cargo run --quiet -p "$CRATE" --features bindgen --bin uniffi-bindgen -- \
	generate --library "$device_lib" --language swift --out-dir "$staging/bindings" ||
	fail "uniffi-bindgen could not generate Swift bindings from $device_lib"

headers="$staging/headers"
mkdir -p "$headers"
cp "$staging"/bindings/*.h "$headers/" || fail "uniffi-bindgen wrote no C header"
modulemaps=("$staging"/bindings/*.modulemap)
[[ -f "${modulemaps[0]}" ]] || fail "uniffi-bindgen wrote no modulemap"
# Xcode finds a framework's Clang module only under the name module.modulemap.
cp "${modulemaps[0]}" "$headers/module.modulemap"

rm -rf "$XCFRAMEWORK"
mkdir -p "$NATIVE_DIR"
xcodebuild -create-xcframework \
	-library "$device_lib" -headers "$headers" \
	-library "$sim_lib" -headers "$headers" \
	-output "$XCFRAMEWORK" >/dev/null ||
	fail "xcodebuild -create-xcframework failed for $XCFRAMEWORK"

rm -rf "$SWIFT_DIR"
mkdir -p "$SWIFT_DIR"
cp "$staging"/bindings/*.swift "$SWIFT_DIR/" || fail "uniffi-bindgen wrote no Swift file"

echo "build-rust-ios: wrote $XCFRAMEWORK and $SWIFT_DIR"
ls -l "$device_lib" "$sim_lib"
