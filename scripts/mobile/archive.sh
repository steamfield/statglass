#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'mobile-archive: %s\n' "$*" >&2
  exit 1
}

step() {
  local name="$1"
  shift
  printf '\n== mobile-archive: %s\n' "$name"
  "$@" || fail "$name failed"
}

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
repo="$PWD"
status=$(git status --porcelain --untracked-files=all --ignore-submodules=none) ||
  fail "cannot inspect the working tree"
[[ -z "$status" ]] || fail "working tree must be clean before archiving"
[[ $(git rev-parse --is-shallow-repository) == false ]] ||
  fail "build numbers require the full Git history"

mobile="$repo/apps/mobile"
output="$mobile/dist/ios"
archive="$output/StatGlass.xcarchive"
ipa="$output/StatGlass.ipa"

STATGLASS_MOBILE_BUILD_NUMBER=$(git rev-list --count HEAD) || fail "cannot determine the build number"
export STATGLASS_MOBILE_BUILD_NUMBER STATGLASS_MOBILE_NAME=StatGlass CI=1
# Expo can load these from .env. Use the resolved identity for both signing steps.
identity=$(bun run --cwd "$mobile" expo config --type public --json) ||
  fail "cannot resolve the Expo release identity"
team=$(jq -er '.ios.appleTeamId | strings | select(test("^[A-Z0-9]{10}$"))' <<< "$identity") ||
  fail "Expo did not resolve a valid Apple team ID"
[[ $(jq -r '.ios.bundleIdentifier' <<< "$identity") == com.tryopendata.statglass.mobile ]] ||
  fail "Expo did not resolve the App Store bundle ID com.tryopendata.statglass.mobile"

mkdir -p "${output%/*}"
scratch=$(mktemp -d "$output.tmp.XXXXXX") || fail "cannot stage release outputs"
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
options="$scratch/ExportOptions.plist"
cp scripts/mobile/ExportOptions.plist "$options"
plutil -insert teamID -string "$team" "$options"

# A rebuild replaces the ignored inputs the checker needs to inspect. Clear the
# old release and remove partial deliverables if any later step fails.
cleanup_release() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    rm -rf -- "$archive"
    rm -f -- "$ipa"
  fi
  rm -rf -- "$scratch"
}
mkdir -p "$output"
trap cleanup_release EXIT
rm -f -- "$ipa"
rm -rf -- "$archive"

step "build Rust for iOS" scripts/mobile/build-rust-ios.sh
step "generate the iOS project" bun run --cwd "$mobile" expo prebuild --platform ios --clean --no-install
status=$(git status --porcelain --untracked-files=all --ignore-submodules=none) ||
  fail "cannot inspect the working tree after Expo prebuild"
[[ -z "$status" ]] || fail "Expo prebuild changed the working tree; inspect git status before retrying"
# Expo's autolinking resolves from the working directory, so --project-directory
# from the repo root breaks the Podfile; CocoaPods also needs a UTF-8 locale.
install_pods() { (cd "$mobile/ios" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install); }
step "install CocoaPods" install_pods

# Keep the Release archive free of development-only entitlements injected by Xcode.
step "archive build $STATGLASS_MOBILE_BUILD_NUMBER" xcodebuild \
  -workspace "$mobile/ios/StatGlass.xcworkspace" -scheme StatGlass -configuration Release \
  -destination generic/platform=iOS -archivePath "$archive" \
  DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO archive
step "export App Store IPA" xcodebuild -exportArchive -archivePath "$archive" \
  -exportOptionsPlist "$options" -exportPath "$scratch/export"

shopt -s nullglob
ipas=("$scratch"/export/*.ipa)
[[ ${#ipas[@]} -eq 1 ]] || fail "Xcode did not export exactly one IPA"
mv "${ipas[0]}" "$ipa"
printf '\nmobile-archive: %s\nmobile-archive: %s\n' "$archive" "$ipa"
