#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'mobile-release-check: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'mobile-release-check: %s\n' "$1"
}

plist_value() {
  plutil -extract "$2" raw -expect "$3" "$1" 2>/dev/null
}

[[ $# -eq 1 ]] || fail 'usage: release-check.sh <xcarchive>'
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
mobile="$repo/apps/mobile"
rules="$repo/scripts/mobile/fixtures/release"
shopt -s nullglob
apps=("$1"/Products/Applications/*.app)
[[ ${#apps[@]} -eq 1 && -d "${apps[0]}" ]] || fail "expected exactly one archived .app in $1/Products/Applications"
app=$(cd "${apps[0]}" && pwd -P)
info="$app/Info.plist"

plutil -lint -s -- "$info" || fail "invalid or missing $info"
encryption=$(plist_value "$info" ITSAppUsesNonExemptEncryption bool) ||
  fail "missing or invalid ITSAppUsesNonExemptEncryption"
[[ "$encryption" == true ]] || fail "ITSAppUsesNonExemptEncryption must be true (D-158)"
for key in NSMicrophoneUsageDescription NSBonjourServices; do
  if plutil -extract "$key" raw "$info" >/dev/null 2>&1; then
    fail "$key must be absent"
  fi
done
names=()
for name_key in CFBundleName CFBundleDisplayName CFBundleExecutable; do
  if name=$(plist_value "$info" "$name_key" string) && [[ -n "$name" ]]; then
    names+=("$name")
  fi
done
for key in NSCameraUsageDescription NSLocalNetworkUsageDescription NSFaceIDUsageDescription; do
  purpose=$(plist_value "$info" "$key" string) || fail "missing or invalid $key"
  [[ "$purpose" =~ [^[:space:]] ]] || fail "$key must explain how the permission is used"
  [[ "$purpose" != "Allow \$(PRODUCT_NAME)"* ]] || fail "$key uses a generic purpose string"
  for name in "${names[@]+"${names[@]}"}"; do
    [[ "$purpose" != "Allow $name to access"* ]] || fail "$key uses a generic purpose string"
  done
done
if plutil -type NSAppTransportSecurity.NSAllowsArbitraryLoads "$info" >/dev/null 2>&1; then
  [[ $(plist_value "$info" NSAppTransportSecurity.NSAllowsArbitraryLoads bool) == false ]] ||
    fail "NSAllowsArbitraryLoads must be false"
fi
families=$(plutil -extract UIDeviceFamily json -expect array -o - "$info") ||
  fail "UIDeviceFamily is missing or invalid"
jq -e '. == [1]' <<< "$families" >/dev/null || fail "UIDeviceFamily must be iPhone only"
orientations=$(plutil -extract UISupportedInterfaceOrientations json -expect array -o - "$info") ||
  fail "UISupportedInterfaceOrientations is missing or invalid"
jq -e 'index("UIInterfaceOrientationPortrait") != null and
  all(.[]; . == "UIInterfaceOrientationPortrait" or . == "UIInterfaceOrientationPortraitUpsideDown")' \
  <<< "$orientations" >/dev/null || fail "UISupportedInterfaceOrientations must contain only portrait orientations"
[[ $(plist_value "$info" CFBundleIdentifier string) == com.tryopendata.statglass.mobile ]] ||
  fail "CFBundleIdentifier must be com.tryopendata.statglass.mobile"
pass "Info.plist permissions, encryption, ATS, device family and orientation passed"

version=$(plist_value "$info" CFBundleShortVersionString string) || fail "missing or invalid CFBundleShortVersionString"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$version" != 0.0.0 ]] ||
  fail "invalid CFBundleShortVersionString ($version)"
build=$(plist_value "$info" CFBundleVersion string) || fail "missing or invalid CFBundleVersion"
[[ "$build" =~ ^[1-9][0-9]*$ ]] || fail "invalid CFBundleVersion ($build)"
pass "version $version ($build)"

executable=$(plist_value "$info" CFBundleExecutable string) || fail "missing or invalid CFBundleExecutable"
[[ -n "$executable" && "$executable" != */* && -f "$app/$executable" && ! -L "$app/$executable" ]] ||
  fail "CFBundleExecutable does not name a file at the bundle root ($executable)"
binary="$app/$executable"
rust_lib="$mobile/modules/statglass-native/ios/StatglassCore.xcframework/ios-arm64/libstatglass_mobile.a"
[[ -f "$rust_lib" ]] || fail "missing device Rust library $rust_lib; check from the worktree that built the archive"

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

reason_codes=$(jq -Rn '
  [inputs | select(length > 0 and (startswith("#") | not)) | split("\t") |
    {key: ("NSPrivacyAccessedAPICategory" + .[0]), value: (.[2] | split(" "))}] | from_entries
' "$rules/required-reason-symbols.txt") || fail "cannot read required-reason policy"

manifest_file_json() {
  local manifest="$1" data
  data=$(plutil -convert json -o - -- "$manifest") || fail "invalid privacy manifest $manifest"
  jq -e 'type == "object" and (keys - ["NSPrivacyAccessedAPITypes", "NSPrivacyCollectedDataTypes",
    "NSPrivacyTracking", "NSPrivacyTrackingDomains"] | length == 0)' <<< "$data" >/dev/null ||
    fail "unexpected keys or type in privacy manifest ($manifest)"
  jq -e '((has("NSPrivacyTracking") | not) or .NSPrivacyTracking == false) and
    ((has("NSPrivacyTrackingDomains") | not) or .NSPrivacyTrackingDomains == []) and
    ((has("NSPrivacyCollectedDataTypes") | not) or .NSPrivacyCollectedDataTypes == [])' <<< "$data" >/dev/null ||
    fail "privacy manifest declares tracking or data collection ($manifest)"
  jq -e --argjson codes "$reason_codes" '
    (has("NSPrivacyAccessedAPITypes") | not) or
      (.NSPrivacyAccessedAPITypes | type == "array" and all(.[];
        ($codes[.NSPrivacyAccessedAPIType // ""] // []) as $allowed |
        (keys == ["NSPrivacyAccessedAPIType", "NSPrivacyAccessedAPITypeReasons"]) and
        (.NSPrivacyAccessedAPITypeReasons | type == "array" and length > 0 and
          all(.[]; . as $reason | $allowed | index($reason) != null))))' <<< "$data" >/dev/null ||
    fail "invalid required-reason declaration ($manifest)"
  printf '%s\n' "$data"
}

manifest_json() {
  local bundle="$1" manifest
  local manifests=()
  if [[ -f "$bundle/PrivacyInfo.xcprivacy" ]]; then
    manifests+=("$bundle/PrivacyInfo.xcprivacy")
  fi
  if [[ "$bundle" == *.framework ]]; then
    manifests+=("$bundle"/*.bundle/PrivacyInfo.xcprivacy)
  fi
  [[ ${#manifests[@]} -gt 0 ]] || fail "PrivacyInfo.xcprivacy is missing from $bundle"
  if [[ "$bundle" == *.framework ]]; then
    for manifest in "${manifests[@]}"; do manifest_file_json "$manifest"; done |
      jq -cs '{NSPrivacyAccessedAPITypes: ([.[].NSPrivacyAccessedAPITypes[]?])}'
  else
    manifest_file_json "${manifests[0]}"
  fi
}

app_manifest=$(manifest_json "$app")
jq -e '.NSPrivacyTracking == false and .NSPrivacyTrackingDomains == [] and .NSPrivacyCollectedDataTypes == []' \
  <<< "$app_manifest" >/dev/null || fail "app privacy manifest must declare no tracking or data collection"

undefined_symbols() {
  # Archive members can repeat imports. Only keep the Mach-O symbol lines.
  xcrun nm -u -j "$1" | awk '/^_/ { print }' | sort -u > "$scratch/imports" ||
    fail "cannot read undefined symbols in $1"
}

selector_references() {
  # Linked Objective-C dispatch stubs can disappear from nm -u.
  xcrun otool -ov "$1" | awk '
    /^Contents of / { selectors = /,__objc_selrefs\) section/ }
    selectors && NF == 2 && $1 ~ /^0x/ { print "_objc_msgSend$" $2 }' >> "$scratch/imports" ||
    fail "cannot read Objective-C selector references in $1"
}

check_private_symbols() {
  local image="$1" pattern reason matches
  while IFS=$'\t' read -r pattern reason; do
    [[ -n "$pattern" && "$pattern" != \#* ]] || continue
    if matches=$(grep -E -- "$pattern" "$scratch/imports"); then
      fail "${image##*/} imports forbidden symbol ${matches%%$'\n'*} ($reason) in $image"
    elif [[ $? -ne 1 ]]; then
      fail "cannot match private symbols in $image"
    fi
  done < "$rules/private-symbols.txt"
}

check_required_reasons() {
  local image="$1" manifest="$2" category pattern matches
  while IFS=$'\t' read -r category pattern _; do
    [[ -n "$category" && "$category" != \#* ]] || continue
    if matches=$(grep -E -- "$pattern" "$scratch/imports"); then
      jq -e --arg category "NSPrivacyAccessedAPICategory$category" '
        any(.NSPrivacyAccessedAPITypes[]?; .NSPrivacyAccessedAPIType == $category)' \
        <<< "$manifest" >/dev/null ||
        fail "${image##*/} imports ${matches%%$'\n'*} without a $category reason in its bundle manifest ($image)"
    elif [[ $? -ne 1 ]]; then
      fail "cannot match required-reason symbols in $image"
    fi
  done < "$rules/required-reason-symbols.txt"
}

read_rpaths() {
  xcrun otool -l "$1" | awk '
    $1 == "cmd" { rpath = ($2 == "LC_RPATH") }
    rpath && $1 == "path" { sub(/^[[:space:]]*path /, ""); sub(/ \(offset [0-9]+\)$/, ""); print }' ||
    fail "cannot read runpaths in $1"
}

check_load_commands() {
  local image="$1" loads install_name own_rpaths path runpath directory candidate resolved
  loads=$(xcrun otool -L "$image" | awk '
    /^[[:space:]]/ { sub(/^[[:space:]]+/, ""); sub(/ \(compatibility version .*$/, ""); print }') ||
    fail "cannot read load commands in $image"
  # otool -L includes a dylib's own install name before its dependencies.
  install_name=$(xcrun otool -D "$image" | sed -n '2p') ||
    fail "cannot read the install name in $image"
  own_rpaths=$(read_rpaths "$image")
  while IFS= read -r path; do
    [[ "$path" != "$install_name" ]] || continue
    case "$path" in
      '') continue ;;
      /System/Library/Frameworks/*|/usr/lib/*)
        [[ "$path" != */../* ]] || fail "disallowed load command $path in $image"
        ;;
      @rpath/*)
        resolved=
        while IFS= read -r runpath; do
          case "$runpath" in
            @executable_path|@executable_path/*) directory="$app${runpath#@executable_path}" ;;
            @loader_path|@loader_path/*) directory="${image%/*}${runpath#@loader_path}" ;;
            /*) directory="$runpath" ;;
            *) continue ;;
          esac
          candidate="$directory/${path#@rpath/}"
          [[ -f "$candidate" ]] || continue
          candidate=$(realpath "$candidate") || fail "cannot resolve $candidate"
          [[ "$candidate" == "$app/"* ]] ||
            fail "out-of-bundle load command $path in $image resolves to $candidate"
          resolved="$candidate"
          break
        done <<< "$own_rpaths"$'\n'"${app_rpaths//\@loader_path/@executable_path}"
        [[ -n "$resolved" ]] || fail "unresolved in-bundle load command $path in $image"
        ;;
      *) fail "disallowed load command $path in $image" ;;
    esac
  done <<< "$loads"
}

[[ -s "$app/main.jsbundle" ]] || fail "main.jsbundle is missing or empty"
dev_client=$(find "$app" \( -iname '*expo-dev-client*' -o -iname '*expo-dev-menu*' -o \
  -iname 'EXDevLauncher*' -o -iname 'EXDevMenu*' -o -iname 'ExpoDevClient*' -o \
  -iname 'ExpoDevLauncher*' -o -iname 'ExpoDevMenu*' \) -print -quit)
[[ -z "$dev_client" ]] || fail "development client or menu in the bundle ($dev_client)"
pass "release JavaScript bundle passed"

undefined_symbols "$rust_lib"
check_private_symbols "$rust_lib"
app_rpaths=$(read_rpaths "$binary")
find "$app" -type d -name '*.framework' -print0 > "$scratch/frameworks"
while IFS= read -r -d '' framework; do
  manifest_json "$framework" >/dev/null
done < "$scratch/frameworks"
find "$app" -type f -print0 > "$scratch/files"
while IFS= read -r -d '' image; do
  kind=$(file -b "$image") || fail "cannot identify $image"
  if [[ "$kind" != *Mach-O* ]]; then
    [[ "$image" != "$binary" ]] || fail "CFBundleExecutable is not Mach-O ($binary)"
    continue
  fi
  bundle="${image%/*}"
  while [[ "$bundle" != "$app" ]]; do
    case "$bundle" in *.framework|*.app|*.appex|*.bundle) break ;; esac
    bundle="${bundle%/*}"
  done
  manifest="$app_manifest"
  if [[ "$bundle" != "$app" ]]; then
    manifest=$(manifest_json "$bundle")
  fi
  undefined_symbols "$image"
  check_private_symbols "$image"
  selector_references "$image"
  check_required_reasons "$image" "$manifest"
  check_load_commands "$image"
done < "$scratch/files"
pass "privacy manifests and required-reason imports passed"
pass "private imports and framework load commands passed"

for image in "$binary" "$rust_lib"; do
  strings "$image" > "$scratch/strings" || fail "cannot read strings in $image"
  if matches=$(grep -oE 'PrivateFrameworks|IOReport|IOHIDEventSystemClient' "$scratch/strings"); then
    pass "advisory strings in ${image##*/} ($(sort -u <<< "$matches" | paste -sd ' ' -))"
  elif [[ $? -ne 1 ]]; then
    fail "cannot match advisory strings in $image"
  fi
done

# Expo can generate its default icon even when the branded PNG exists in the checkout.
for icon in "$mobile/assets/icon-light.png" \
  "$mobile/ios/StatGlass/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png"; do
  [[ -f "$icon" ]] || fail "missing icon input $icon"
  hash=$(md5 -q "$icon") || fail "cannot hash $icon"
  if grep -Fxq -- "$hash" "$rules/placeholder-icon-hashes.txt"; then
    fail "${icon##*/} matches a placeholder icon hash ($hash)"
  elif [[ $? -ne 1 ]]; then
    fail "cannot read the placeholder icon hashes"
  fi
done
[[ -f "$app/Assets.car" ]] || fail "Assets.car is missing"
xcrun assetutil --info "$app/Assets.car" > "$scratch/assets.json" ||
  fail "assetutil could not read $app/Assets.car"
jq -e 'any(.[]; .Name? == "AppIcon")' "$scratch/assets.json" >/dev/null ||
  fail "Assets.car does not contain AppIcon"
pass "AppIcon and source icon hash passed"

codesign -d --entitlements - --xml "$binary" > "$scratch/entitlements.plist" 2> "$scratch/codesign.log" ||
  fail "cannot read the app signature entitlements ($(cat "$scratch/codesign.log"))"
if [[ -s "$scratch/entitlements.plist" ]]; then
  plutil -lint -s -- "$scratch/entitlements.plist" || fail "cannot parse the app signature entitlements"
  if plutil -extract get-task-allow raw "$scratch/entitlements.plist" >/dev/null 2>&1; then
    fail "get-task-allow entitlement must be absent"
  fi
fi
pass "distribution entitlements passed"

# The archived framework can be re-signed by Xcode. Inspect the SDK as installed by CocoaPods.
hermes_pods="$mobile/ios/Pods/hermes-engine"
hermes_sdk=
if [[ -d "$hermes_pods" ]]; then
  hermes_sdk=$(find "$hermes_pods" -type d -iname 'hermes*.xcframework' -print -quit)
fi
if [[ -z "$hermes_sdk" ]]; then
  pass "Hermes SDK signature not checked (CocoaPods XCFramework unavailable)"
elif signature=$(codesign -d --verbose=2 "$hermes_sdk" 2>&1); then
  details=$(awk '/^(Authority|TeamIdentifier|Signature)=/' <<< "$signature")
  pass "Hermes SDK signature ($(paste -sd ' ' - <<< "$details"))"
else
  pass "Hermes SDK signature unavailable ($signature)"
fi

pass "archive passed"
