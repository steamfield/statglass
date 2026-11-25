#!/usr/bin/env bash
# Builds StatglassCore.xcframework and its UniFFI Swift bindings for the iOS
# simulator, then compiles the statglass-native Expo module against them.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_app="$repo_root/apps/mobile"

fail() {
  printf 'mobile-native-check: %s\n' "$1" >&2
  exit 1
}

step() {
  local name="$1"
  shift
  printf '\n== mobile-native-check: %s\n' "$name"
  if ! "$@"; then fail "$name failed"; fi
}

if [[ -e "$source_app/ios" || -L "$source_app/ios" ]]; then
  fail "apps/mobile/ios already exists"
fi

cd "$repo_root"
step "build Rust for iOS" scripts/mobile/build-rust-ios.sh

# Expo prebuild edits package.json as well as generating ios/. Give it a copy
# of the app in a temporary workspace, using the existing dependency install.
scratch=$(mktemp -d) || fail "could not create a temporary workspace"
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mobile="$scratch/apps/mobile"

step "create temporary workspace" mkdir -p "$mobile"
step "stage workspace manifest" cp package.json bun.lock "$scratch/"
step "link workspace dependencies" ln -s "$repo_root/node_modules" "$repo_root/packages" "$scratch/"
step "stage mobile app" rsync -a --exclude='/ios' --exclude='/node_modules' \
  --exclude='/modules' --exclude='/dist' --exclude='/.expo' "$source_app/" "$mobile/"
step "link app dependencies" ln -s "$source_app/node_modules" "$source_app/modules" "$mobile/"

# Use the default app name so the generated workspace and scheme are StatGlass.
step "Expo prebuild" env CI=1 STATGLASS_MOBILE_NAME=StatGlass \
  bun run --cwd "$mobile" expo prebuild --platform ios --no-install
cd "$mobile/ios" || fail "Expo prebuild did not create the iOS project"
step "CocoaPods install" pod install
# The Rust XCFramework contains only the arm64 simulator slice.
step "Xcode simulator build" xcodebuild -workspace "$mobile/ios/StatGlass.xcworkspace" \
  -scheme StatGlass -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$scratch/DerivedData" ARCHS=arm64 build

printf '\nmobile-native-check: simulator build passed\n'
