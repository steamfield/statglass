#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
fixture="$scratch/release fixture"
archive="$fixture/StatGlass.xcarchive"
app="$archive/Products/Applications/StatGlass.app"
framework="$app/Frameworks/Fixture.framework"
plist="$app/Info.plist"
manifest="$app/PrivacyInfo.xcprivacy"
icon="$fixture/apps/mobile/assets/icon-light.png"
generated_icon="$fixture/apps/mobile/ios/StatGlass/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png"
rust_lib="$fixture/apps/mobile/modules/statglass-native/ios/StatglassCore.xcframework/ios-arm64/libstatglass_mobile.a"
checker="$fixture/scripts/mobile/release-check.sh"

# Run the real entry point with the archive and its two build inputs in isolation.
mkdir -p "$framework" "${icon%/*}" "${generated_icon%/*}" "${rust_lib%/*}" "${checker%/*}"
cp -R scripts/mobile/fixtures "${checker%/*}/"
cp scripts/mobile/{archive,release-check}.sh scripts/mobile/ExportOptions.plist "${checker%/*}/"

cat > "$scratch/main.c" <<'EOF'
extern int fixture_value(void);
int main(void) { return fixture_value(); }
EOF
cat > "$scratch/library.c" <<'EOF'
extern unsigned long long mach_absolute_time(void);
extern const void *NSFileSystemFreeSize;
int fixture_value(void) { return mach_absolute_time() != 0; }
int fixture_disk_space(void) { return NSFileSystemFreeSize != 0; }
int IOReportFixture(void) { return 0; }
EOF
cat > "$scratch/private.c" <<'EOF'
extern int IOReportFixture(void);
int main(void) { return IOReportFixture(); }
EOF
cat > "$scratch/strings.c" <<'EOF'
const char *fixture_message(void) { return "PrivateFrameworks / IOReport"; }
EOF
cat > "$scratch/selectors.m" <<'EOF'
#import <Foundation/Foundation.h>
NSDate *fixture_date(NSDictionary *attributes) { return attributes.fileModificationDate; }
EOF
clang=(xcrun --sdk iphoneos clang -target arm64-apple-ios16.4)
install_name='@rpath/Fixture.framework/Fixture'
"${clang[@]}" -dynamiclib "$scratch/library.c" "$scratch/selectors.m" -framework Foundation \
  -install_name "$install_name" -o "$framework/Fixture"
"${clang[@]}" "$scratch/main.c" "$framework/Fixture" -Wl,-rpath,@executable_path/Frameworks -o "$app/StatGlass"
"${clang[@]}" "$scratch/main.c" "$framework/Fixture" \
  -Wl,-rpath,@executable_path/../../../External -Wl,-rpath,@executable_path/Frameworks -o "$scratch/outside-load"
"${clang[@]}" "$scratch/private.c" "$framework/Fixture" -Wl,-rpath,@executable_path/Frameworks -o "$scratch/private"
"${clang[@]}" -dynamiclib "$scratch/library.c" -framework Foundation \
  -install_name /System/Library/PrivateFrameworks/Fixture.framework/Fixture -o "$scratch/private-load.dylib"
"${clang[@]}" "$scratch/main.c" "$scratch/private-load.dylib" -o "$scratch/private-load"
"${clang[@]}" -dynamiclib "$scratch/library.c" -framework Foundation \
  -install_name /System/Library/Frameworks/../PrivateFrameworks/Fixture.framework/Fixture -o "$scratch/traversal.dylib"
"${clang[@]}" "$scratch/main.c" "$scratch/traversal.dylib" -o "$scratch/traversal"
"${clang[@]}" -c "$scratch/strings.c" -o "$scratch/strings.o"
"${clang[@]}" -c "$scratch/private.c" -o "$scratch/private.o"
xcrun ar -rcs "$rust_lib" "$scratch/strings.o"
xcrun ar -rcs "$scratch/private.a" "$scratch/private.o"

plutil -create xml1 "$plist"
plutil -insert CFBundleExecutable -string StatGlass "$plist"
plutil -insert CFBundleName -string StatGlass "$plist"
plutil -insert CFBundleIdentifier -string com.tryopendata.statglass.mobile "$plist"
plutil -insert CFBundleShortVersionString -string 1.0.0 "$plist"
plutil -insert CFBundleVersion -string 42 "$plist"
plutil -insert ITSAppUsesNonExemptEncryption -bool true "$plist"
plutil -insert NSCameraUsageDescription -string 'Scan the pairing code.' "$plist"
plutil -insert NSFaceIDUsageDescription -string 'Unlock StatGlass.' "$plist"
plutil -insert NSLocalNetworkUsageDescription -string 'Connect to your hosts.' "$plist"
plutil -insert NSAppTransportSecurity -json '{"NSAllowsArbitraryLoads":false,"NSAllowsLocalNetworking":true}' "$plist"
plutil -insert UIDeviceFamily -json '[1]' "$plist"
plutil -insert UISupportedInterfaceOrientations -json '["UIInterfaceOrientationPortrait","UIInterfaceOrientationPortraitUpsideDown"]' "$plist"
plutil -create xml1 "$manifest"
plutil -insert NSPrivacyTracking -bool false "$manifest"
plutil -insert NSPrivacyTrackingDomains -array "$manifest"
plutil -insert NSPrivacyCollectedDataTypes -array "$manifest"
plutil -insert NSPrivacyAccessedAPITypes -json \
  '[{"NSPrivacyAccessedAPIType":"NSPrivacyAccessedAPICategorySystemBootTime","NSPrivacyAccessedAPITypeReasons":["35F9.1"]},{"NSPrivacyAccessedAPIType":"NSPrivacyAccessedAPICategoryDiskSpace","NSPrivacyAccessedAPITypeReasons":["E174.1"]},{"NSPrivacyAccessedAPIType":"NSPrivacyAccessedAPICategoryFileTimestamp","NSPrivacyAccessedAPITypeReasons":["C617.1"]}]' "$manifest"
cp "$manifest" "$framework/PrivacyInfo.xcprivacy"
cp "$manifest" "$scratch/framework-privacy.plist"
cp "$plist" "$scratch/good.plist"
cp "$app/StatGlass" "$scratch/good-executable"
cp "$rust_lib" "$scratch/good.a"
printf 'fixture bundle\n' > "$app/main.jsbundle"

catalog="$scratch/Assets.xcassets"
mkdir -p "$catalog/AppIcon.appiconset"
printf '{"info":{"version":1,"author":"xcode"}}\n' > "$catalog/Contents.json"
printf '%s\n' '{"images":[{"filename":"icon.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"version":1,"author":"xcode"}}' \
  > "$catalog/AppIcon.appiconset/Contents.json"
# The same generator Expo uses for its default icon supplies both fixtures.
node - "$icon" "$scratch/placeholder.png" <<'EOF'
const { createSquareAsync } = require("@expo/image-utils");
const { writeFile } = require("node:fs/promises");
async function main() {
  await writeFile(process.argv[2], await createSquareAsync({ size: 1024, color: "#123456" }));
  await writeFile(process.argv[3], await createSquareAsync({ size: 1024 }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
EOF
cp "$icon" "$catalog/AppIcon.appiconset/icon.png"
cp "$icon" "$generated_icon"
compile_icon() {
  xcrun actool "$catalog" --compile "$app" --platform iphoneos --minimum-deployment-target 16.4 \
    --target-device iphone --app-icon AppIcon --output-partial-info-plist "$scratch/icon.plist" >/dev/null
}
compile_icon

passed=0
pass() {
  printf 'PASS %s\n' "$1"
  passed=$((passed + 1))
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

expect_failure() {
  local expected="$1" output
  shift
  if output=$("$@" 2>&1); then
    fail "expected rejection containing '$expected'"
  fi
  if ! grep -Fq -- "$expected" <<< "$output"; then
    printf '%s\n' "$output" >&2
    fail "expected diagnostic containing '$expected'"
  fi
  pass "$expected"
}

codesign --force --sign - "$app/StatGlass"
output=$("$checker" "$archive") || fail "valid archive"
for advisory in IOReport PrivateFrameworks; do
  grep -Eq "advisory.*$advisory" <<< "$output" || fail "valid archive should report the advisory strings"
done
pass "valid archive with a framework and advisory strings"

mkdir "$framework/Fixture_Privacy.bundle"
mv "$framework/PrivacyInfo.xcprivacy" "$framework/Fixture_Privacy.bundle/"
"$checker" "$archive" > "$scratch/nested.log" || { cat "$scratch/nested.log"; fail "valid nested framework manifest"; }
mv "$framework/Fixture_Privacy.bundle/PrivacyInfo.xcprivacy" "$framework/"
rmdir "$framework/Fixture_Privacy.bundle"
pass "valid nested framework manifest"

expect_failure 'usage: release-check.sh' "$checker"
expect_failure 'expected exactly one archived .app' "$checker" "$scratch/missing.xcarchive"

plutil -remove ITSAppUsesNonExemptEncryption "$plist"
expect_failure 'missing or invalid ITSAppUsesNonExemptEncryption' "$checker" "$archive"
cp "$scratch/good.plist" "$plist"

plutil -insert NSMicrophoneUsageDescription -string 'Use the microphone.' "$plist"
expect_failure 'NSMicrophoneUsageDescription must be absent' "$checker" "$archive"
cp "$scratch/good.plist" "$plist"

plutil -replace NSCameraUsageDescription -string "Allow \$(PRODUCT_NAME) to access your camera." "$plist"
expect_failure 'NSCameraUsageDescription uses a generic purpose string' "$checker" "$archive"
plutil -replace NSCameraUsageDescription -string "Allow StatGlass to access your camera." "$plist"
expect_failure 'NSCameraUsageDescription uses a generic purpose string' "$checker" "$archive"
cp "$scratch/good.plist" "$plist"

plutil -replace NSAppTransportSecurity.NSAllowsArbitraryLoads -bool true "$plist"
expect_failure 'NSAllowsArbitraryLoads must be false' "$checker" "$archive"
cp "$scratch/good.plist" "$plist"

plutil -replace UISupportedInterfaceOrientations -json '["UIInterfaceOrientationLandscapeLeft"]' "$plist"
expect_failure 'UISupportedInterfaceOrientations must contain only portrait orientations' "$checker" "$archive"
cp "$scratch/good.plist" "$plist"

plutil -replace CFBundleShortVersionString -string 0.0.0 "$plist"
expect_failure 'invalid CFBundleShortVersionString (0.0.0)' "$checker" "$archive"
cp "$scratch/good.plist" "$plist"

plutil -remove NSPrivacyAccessedAPITypes.0 "$framework/PrivacyInfo.xcprivacy"
expect_failure 'Fixture imports _mach_absolute_time without a SystemBootTime reason' "$checker" "$archive"
cp "$scratch/framework-privacy.plist" "$framework/PrivacyInfo.xcprivacy"
plutil -remove NSPrivacyAccessedAPITypes.1 "$framework/PrivacyInfo.xcprivacy"
expect_failure 'Fixture imports _NSFileSystemFreeSize without a DiskSpace reason' "$checker" "$archive"
cp "$scratch/framework-privacy.plist" "$framework/PrivacyInfo.xcprivacy"
plutil -remove NSPrivacyAccessedAPITypes.2 "$framework/PrivacyInfo.xcprivacy"
expect_failure "Fixture imports _objc_msgSend\$fileModificationDate without a FileTimestamp reason" "$checker" "$archive"
cp "$scratch/framework-privacy.plist" "$framework/PrivacyInfo.xcprivacy"
plutil -replace NSPrivacyAccessedAPITypes.0.NSPrivacyAccessedAPITypeReasons -json '["35F9.1","BAD.1"]' "$framework/PrivacyInfo.xcprivacy"
expect_failure 'invalid required-reason declaration' "$checker" "$archive"
cp "$scratch/framework-privacy.plist" "$framework/PrivacyInfo.xcprivacy"
plutil -replace NSPrivacyTracking -bool true "$framework/PrivacyInfo.xcprivacy"
expect_failure 'privacy manifest declares tracking or data collection' "$checker" "$archive"
rm "$framework/PrivacyInfo.xcprivacy"
expect_failure 'PrivacyInfo.xcprivacy is missing from' "$checker" "$archive"
cp "$scratch/framework-privacy.plist" "$framework/PrivacyInfo.xcprivacy"

cp "$scratch/private" "$app/StatGlass"
expect_failure 'StatGlass imports forbidden symbol _IOReportFixture' "$checker" "$archive"
cp "$scratch/good-executable" "$app/StatGlass"
cp "$scratch/private.a" "$rust_lib"
expect_failure 'libstatglass_mobile.a imports forbidden symbol _IOReportFixture' "$checker" "$archive"
cp "$scratch/good.a" "$rust_lib"

cp "$scratch/private-load" "$app/StatGlass"
expect_failure 'disallowed load command /System/Library/PrivateFrameworks/' "$checker" "$archive"
cp "$scratch/traversal" "$app/StatGlass"
expect_failure 'disallowed load command /System/Library/Frameworks/../' "$checker" "$archive"
mkdir -p "$archive/External"
cp -R "$framework" "$archive/External/"
cp "$scratch/outside-load" "$app/StatGlass"
expect_failure 'out-of-bundle load command @rpath/Fixture.framework/Fixture' "$checker" "$archive"
cp "$scratch/good-executable" "$app/StatGlass"

mv "$framework/Fixture" "$scratch/embedded"
expect_failure 'unresolved in-bundle load command @rpath/Fixture.framework/Fixture' "$checker" "$archive"
mv "$scratch/embedded" "$framework/Fixture"

cp "$scratch/placeholder.png" "$icon"
expect_failure 'icon-light.png matches a placeholder icon hash' "$checker" "$archive"
cp "$catalog/AppIcon.appiconset/icon.png" "$icon"
cp "$scratch/placeholder.png" "$generated_icon"
cp "$scratch/placeholder.png" "$catalog/AppIcon.appiconset/icon.png"
compile_icon
expect_failure 'App-Icon-1024x1024@1x.png matches a placeholder icon hash' "$checker" "$archive"
cp "$icon" "$generated_icon"
cp "$icon" "$catalog/AppIcon.appiconset/icon.png"
compile_icon

mv "$app/Assets.car" "$scratch/Assets.car"
expect_failure 'Assets.car is missing' "$checker" "$archive"
mv "$scratch/Assets.car" "$app/Assets.car"

plutil -create xml1 "$scratch/entitlements.plist"
plutil -insert get-task-allow -bool true "$scratch/entitlements.plist"
codesign --force --sign - --entitlements "$scratch/entitlements.plist" "$app/StatGlass"
expect_failure 'get-task-allow entitlement must be absent' "$checker" "$archive"
cp "$scratch/good-executable" "$app/StatGlass"

mv "$app/main.jsbundle" "$scratch/main.jsbundle"
expect_failure 'main.jsbundle is missing or empty' "$checker" "$archive"
mv "$scratch/main.jsbundle" "$app/main.jsbundle"

mkdir "$app/Frameworks/EXDevMenu.framework"
expect_failure 'development client or menu in the bundle' "$checker" "$archive"
rmdir "$app/Frameworks/EXDevMenu.framework"

git -C "$fixture" init -q
expect_failure 'working tree must be clean' "${checker%/*}/archive.sh"

export_options=scripts/mobile/ExportOptions.plist
if grep -Ein 'altool|notarytool|destination[[:space:]]+upload|<string>upload</string>' \
  scripts/mobile/archive.sh "$export_options"; then
  fail "archive must export locally"
fi
[[ $(plutil -extract destination raw -expect string "$export_options") == export ]] ||
  fail "ExportOptions.plist destination must be export"
pass "local export only"

# The export command runs from its -exportArchive line to the first line without a
# trailing backslash.
sed -n '/-exportArchive/,/[^\\]$/p' scripts/mobile/archive.sh | grep -q -- -allowProvisioningUpdates ||
  fail "the export must let Xcode create a missing distribution certificate"
grep -q -- '-exportArchive' <(grep -- 'PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild' scripts/mobile/archive.sh) ||
  fail "the export must run with system tools only (Homebrew rsync breaks the IPA copy)"
pass "export provisions its own signing"

printf 'release-check-test: %d cases passed\n' "$passed"
