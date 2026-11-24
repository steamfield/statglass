#!/usr/bin/env bash
# cargo check and clippy (-D warnings) for statglass-mobile on the Apple Silicon iOS
# simulator target. Clippy also lints the workspace crates it links (engine, collect,
# store, proto, schema) as built for iOS, so iOS-only dead code or cfg mistakes fail here.
set -euo pipefail

readonly TARGET=aarch64-apple-ios-sim

cd "$(dirname "$0")/../.."

if ! rustup target list --installed | grep -qx "$TARGET"; then
	echo "mobile-rust-check: Rust target $TARGET is not installed; run: rustup target add $TARGET" >&2
	exit 1
fi

cargo check --target "$TARGET" -p statglass-mobile ||
	{ echo "mobile-rust-check: cargo check failed for $TARGET" >&2; exit 1; }
cargo clippy --target "$TARGET" -p statglass-mobile --all-targets -- -D warnings ||
	{ echo "mobile-rust-check: clippy failed for $TARGET" >&2; exit 1; }
echo "mobile-rust-check: statglass-mobile checks clean for $TARGET"
