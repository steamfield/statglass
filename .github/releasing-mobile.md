# Releasing StatGlass for iPhone

Build on a Mac with Xcode and an iOS SDK that meets [Apple's upload requirements](https://developer.apple.com/news/upcoming-requirements/). Install the repo's Bun, Rust and CocoaPods prerequisites, including the `aarch64-apple-ios` and `aarch64-apple-ios-sim` Rust targets. Sign Xcode in to an account on team `YWA9Q642YP`; the export uses automatic signing with `-allowProvisioningUpdates`, so Xcode creates or downloads the Apple Distribution certificate and App Store profile itself.

## Build and check

Run both commands from a clean checkout with the full Git history and dependencies installed. Run `make mobile-check` and any `export:ios` builds first, since the Expo export clears `apps/mobile/dist/ios/`. If you need to retain earlier release files, copy them elsewhere before rebuilding.

```sh
make mobile-archive
make mobile-release-check
```

The first command regenerates `apps/mobile/ios/` and writes `StatGlass.xcarchive` and `StatGlass.ipa` to `apps/mobile/dist/ios/`. The second checks both: the archive for its contents and the IPA for the distribution signature. Keep the generated project and the device Rust library in that checkout for the second command. The version comes from `apps/mobile/package.json`. The build number is the commit count at `HEAD`. Check that it exceeds the most recent build you uploaded, especially after changing branches.

Read the Hermes SDK signature line in the checker output. If the vendor XCFramework has no signature, inspect the installed CocoaPods artifact before opening Organizer. The checker also prints advisory strings found in the app or Rust library. The import and load-command checks determine whether private APIs fail the archive check. [Apple's SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)

## Run the release build in Simulator

Use the generated workspace from `make mobile-archive`. Build Release for a separate simulator using the same commit count as the archive. Follow the simulator skill for appearance, Dynamic Type and screenshots. [Simulator skill](../.claude/skills/ios-simulator/SKILL.md)

```sh
STATGLASS_MOBILE_BUILD_NUMBER="$(git rev-list --count HEAD)" \
  xcodebuild -workspace apps/mobile/ios/StatGlass.xcworkspace -scheme StatGlass \
  -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/mobile/dist/simulator ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build
```

Install `apps/mobile/dist/simulator/Build/Products/Release-iphonesimulator/StatGlass.app` with `xcrun simctl install`. Use the selected simulator's UDID in each command.

- Start `xcrun simctl spawn <UDID> log stream --predicate 'subsystem == "app.statglass"'` before launching. On a cold install with no hosts, time the first launch. Welcome should appear within three seconds. Tap **Try demo hosts**, open a host, and open CPU. Confirm the app stays up and inspect the log for connection warnings. Use the reviewer-path test's native-call record to verify zero session and dial calls. The Release log can omit a dial attempt.
- Check light, dark and AX1 (`simctl ui <UDID> content_size accessibility-medium`). Check the Home Screen icon in light, dark and tinted appearances and watch the launch screen for a white flash in dark. Confirm `statglass://debug` redirects to the app root. Check the version and both links in Settings > About.
- Install on an iPad simulator and check the same path in iPhone compatibility mode. If the runtime includes iPhone Duo, check both the closed and open postures for clipping or black bars.
- On a 1206 × 2622 iPhone simulator, set the status bar with `xcrun simctl status_bar <UDID> override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState discharging --batteryLevel 100`. Capture five demo screens with `xcrun simctl io <UDID> screenshot <path>` under `apps/mobile/dist/store/`, for example Hosts, host overview, CPU, Memory and Network. Confirm the dimensions and remove any alpha channel before upload. Clear the override with `xcrun simctl status_bar <UDID> clear`. [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)

Run `cargo test -p statglass-ssh --test ipv6 -- --nocapture` and confirm the `[::1]` fixture completed the handshake. Run `ensure-docker` and `make ssh-docker-test`. For the IPv6 run, verify both dialers reach the container at an IPv6 address and record the endpoint. The existing runner publishes to `127.0.0.1`. If the runtime offers no reachable IPv6 address, record that and keep the IPv4 result.

## App Store Connect checklist

- [ ] Create the iOS app record. Use **StatGlass** (fallback **StatGlass Monitor**), bundle ID `com.tryopendata.statglass.mobile`, and a unique SKU, for example `statglass-iphone`. Set Utilities as the primary category and Developer Tools as the secondary category.
- [ ] Confirm the public page loads and both anchors work. Enter the URLs in App Store Connect. [Privacy policy](https://statglass.steamfield.io/docs/iphone#privacy) · [Support](https://statglass.steamfield.io/docs/iphone#support)
- [ ] Set App Privacy to **Data Not Collected**. [App Privacy details](https://developer.apple.com/app-store/app-privacy-details/)
- [ ] Answer export compliance per [D-158](../plan/decisions.md#d-156-statglass-for-iphone-ships-on-the-app-store). The app implements standard encryption algorithms outside the Apple OS, so `ITSAppUsesNonExemptEncryption` is true. Exclude France from availability and account for the app in the BIS annual self-classification report. If you later choose to distribute in France, file the French encryption declaration and use the compliance code Apple issues. [Apple's export documentation](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption) · [BIS reporting](https://www.bis.gov/learn-support/encryption-controls/annual-self-classification)
- [ ] Complete the age rating questionnaire. Run Accessibility Inspector on welcome, Hosts, a host, a module page and Settings. Use the results to decide which voluntary Accessibility Nutrition Labels to report. [Accessibility Nutrition Labels](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels)
- [ ] Add the five iPhone screenshots. For uploads from April 2027 built with the iOS 27.1 SDK or later, add iPhone Duo screenshots. [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [ ] Paste the review notes below into App Review Information.
- [ ] Open the archive in Xcode Organizer and choose **Validate App**. After validation, upload from Organizer or open the exported `StatGlass.ipa` in Transporter. Select the processed build in App Store Connect. [Manual upload](https://docs.expo.dev/submit/ios-manual/)
- [ ] Finish the TestFlight device checks below before submitting the build for review.
- [ ] After approval, record the approved build's protocol range and features in [`compat/mobile-protocol.json`](../compat/mobile-protocol.json). Tag the release commit `mobile-vX.Y.Z` using the approved marketing version.

### Notes for App Review

> StatGlass has no account. Tap **Try demo hosts** on the first screen. The hosts are simulated and let you try every monitoring feature. Open a host, then tap CPU to see live readings and history.
>
> To monitor your own hosts, pair with StatGlass on a Mac or `statglass-agent` on Linux by scanning its pairing QR code. Each code expires within minutes, so we cannot attach a sample code that would still work in review.
>
> The camera is used only to scan the pairing code. StatGlass asks for Local Network access only when connecting to a host on the same network. Face ID unlocks the app when you turn on App Lock.
>
> The app sends nothing to the developer.

### TestFlight device checks

- [ ] On a physical iPhone, scan a fresh pairing QR code and connect. Confirm the generated phone signing key uses the Secure Enclave and works again after relaunch.
- [ ] On the same network as the host, check the Local Network prompt. Deny it and confirm the app shows the `local_network` error. Enable access in iOS Settings and confirm the connection works.
- [ ] Set up a DNS64/NAT64 network with Internet Sharing on a Mac. Join it from the iPhone, disable cellular, and connect to an IPv4-only SSH host using an IPv4 literal on the Mac's uplink side. Verify that pairing and live metrics work over the translated connection. Repeat with the host's DNS name. [Apple's NAT64 test setup](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/NetworkingOverview/UnderstandingandPreparingfortheIPv6Transition/UnderstandingandPreparingfortheIPv6Transition.html)
