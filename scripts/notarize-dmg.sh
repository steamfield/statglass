#!/usr/bin/env bash
# Sign, notarize and staple the release DMG, then check the app and DMG pass Gatekeeper.
#
# `tauri build` with the release config signs the app with the Developer ID and, when
# the APPLE_API_* variables are set, notarizes and staples the .app before it builds the
# DMG and updater archive. It does not notarize the DMG, so this finishes the job. It
# also fails if the app itself was never notarized: Tauri skips that step silently when
# the APPLE_API_* variables are missing.
#
# Notary credentials, either:
#   NOTARY_PROFILE=statglass-notary                     (local keychain profile), or
#   APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH (CI, App Store Connect API key)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="${1:-$ROOT/target/release/bundle}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Riley Hilliard (YWA9Q642YP)}"
APP="$BUNDLE/macos/StatGlass.app"

shopt -s nullglob
dmgs=("$BUNDLE"/dmg/*.dmg)
[[ ${#dmgs[@]} -eq 1 ]] || { echo "notarize-dmg: expected one DMG in $BUNDLE/dmg, found ${#dmgs[@]}." >&2; exit 1; }
DMG="${dmgs[0]}"

if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  AUTH=(--keychain-profile "$NOTARY_PROFILE")
else
  : "${APPLE_API_KEY:?set NOTARY_PROFILE or APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH}"
  AUTH=(--key "${APPLE_API_KEY_PATH:?}" --key-id "$APPLE_API_KEY" --issuer "${APPLE_API_ISSUER:?}")
fi

echo "notarize-dmg: checking the app"
codesign --verify --deep --strict --verbose=2 "$APP"
TEAM="${IDENTITY##*(}"
codesign -dv "$APP" 2>&1 | grep -q "TeamIdentifier=${TEAM%)}" ||
  { echo "notarize-dmg: $APP is not signed with $IDENTITY." >&2; exit 1; }
xcrun stapler validate "$APP" ||
  { echo "notarize-dmg: the app has no notarization ticket. Were the APPLE_API_* variables set for tauri build?" >&2; exit 1; }
spctl --assess --type execute --verbose=2 "$APP"

echo "notarize-dmg: signing and notarizing $(basename "$DMG")"
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
result="$(xcrun notarytool submit "$DMG" "${AUTH[@]}" --wait --output-format json)"
echo "$result"
id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$result")"
status="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["status"])' "$result")"
if [[ "$status" != Accepted ]]; then
  xcrun notarytool log "$id" "${AUTH[@]}" >&2 || true
  echo "notarize-dmg: notarization finished with status $status." >&2
  exit 1
fi
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
echo "notarize-dmg: $DMG is signed, notarized and stapled."
