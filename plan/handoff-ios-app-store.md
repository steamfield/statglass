# StatGlass for iPhone: App Store handoff

Status on 2026-11-25, with build 1135 cut from main at `90b16d7c` (after the export and release-check
fixes merged). The code for StatGlass for iPhone 1.0.0 is done: RFC phases
0 to 4, the polish RFC (`plan/rfc-ios-polish.md`) and App Store readiness (plan phase 13)
all landed, and the final whole-branch review ran with its findings fixed. Signing works,
build 1.0.0 (1135) from main passes `make mobile-release-check`, and the store
screenshots are taken. What is left is App Store Connect, the upload, a device pass and
submitting. The release runbook is
`.github/releasing-mobile.md`; this file says what has and hasn't been done against it.

## Done

- App icon: the heat-grid mark from the desktop's `src-tauri/icons/icon.png`, in light
  (1024 px, no alpha, as the store icon requires), dark and tinted variants
  (`apps/mobile/assets/icon-*.png`). The release check confirms `Assets.car` holds the
  AppIcon and that no image is a placeholder.
- The privacy and support page is live at
  `https://statglass.steamfield.io/docs/iphone`, with both `#privacy` and `#support`
  anchors.

### Distribution certificate and export

With your go-ahead, the export now passes `-allowProvisioningUpdates`, and on its first run
Xcode created a cloud-managed "Apple Distribution: Riley Hilliard (YWA9Q642YP)" certificate
and the App Store profile for `com.tryopendata.statglass.mobile`. On 2026-11-25
`make mobile-archive` exported `StatGlass.ipa` 1.0.0 (1131), 22.4 MB, signed by that
certificate with `get-task-allow` false, and `make mobile-release-check` passed on it.

That first real run needed four fixes, now on main: the export runs with only system tools
on PATH (Homebrew's rsync broke Xcode's IPA copy), the checker reads Rust's symbols with
`nm --no-llvm-bc`, Expo frameworks without their own privacy manifest are checked against
the app's, and the entitlements are read from the IPA instead of the development-signed
archive. Two lines in the output are expected: the Hermes SDK signature line (CocoaPods'
copy is unsigned; Xcode signs the embedded one) and the advisory strings
`IOHIDEventSystemClient IOReport`, which are text in the Rust library, not imports.

After the fixes merged, main at `90b16d7c` was rebuilt: `make mobile-check`,
`make mobile-archive` and `make mobile-release-check` all passed, and
`apps/mobile/dist/ios/StatGlass.ipa` is 1.0.0 (1135). Upload that one. If you rebuild, the
build number is the commit count and must exceed any build already uploaded; nothing has
been uploaded yet.

### Store screenshots

Taken from the Release simulator build of 1135 on an iPhone 17 simulator (1206 x 2622,
the required "iPhone with Dynamic Island, medium display" size), demo hosts, status bar
set to 9:41. Two sets, pick one: `apps/mobile/dist/store/dark/` and
`apps/mobile/dist/store/light/`, each `1-hosts`, `2-host` (MacBook Pro), `3-cpu`,
`4-memory`, `5-network`. They are JPEG with no alpha channel, as App Store Connect
requires. `dist/` is git-ignored, so they exist only on this Mac. The hosts list shows the
"Demo" pill and a disabled `studio` host, which is what a reviewer sees in demo mode.

To retake them headless, the simulator needs the `statglass` scheme pre-approved or every
`simctl openurl` stops on an "Open in StatGlass?" alert: write
`com.apple.CoreSimulator.CoreSimulatorBridge-->statglass = com.tryopendata.statglass.mobile`
into the device's `data/Library/Preferences/com.apple.launchservices.schemeapproval.plist`
while it is shut down. Then `statglass://demo` starts demo mode, and
`statglass:///<host id>/<module>` opens a page (the MacBook Pro demo host is
`6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a11`).

### Release simulator checks

On the same build, the iPad Pro 11-inch (M5) simulator runs the app in its iPhone
compatibility window without black bars or broken layout, the demo path works, and
`statglass://debug` lands on the app root. Not yet done: cold-launch timing, the AX1 and
Home Screen icon appearance passes, and an iPhone Duo check (no Duo runtime here).

## Left to do, in order

### 1. App Store Connect (you)

Follow the checklist in `.github/releasing-mobile.md`. Decisions already made (D-156,
D-158): name StatGlass, Utilities with Developer Tools secondary, Data Not Collected,
`ITSAppUsesNonExemptEncryption` true with France excluded from availability, review
access through "Try demo hosts" only (the review notes are in the runbook).

Nothing is created there yet. Still to do: the app record, the metadata above, the
screenshots (upload one set from `apps/mobile/dist/store/`), the age rating and the
Accessibility Nutrition Labels.

### 2. Upload (you)

Validate and upload the rebuilt archive from Xcode Organizer, or open
`apps/mobile/dist/ios/StatGlass.ipa` in Transporter; both use your Apple ID sign-in.
`make mobile-archive` never uploads (D-158). Select the processed build in App Store
Connect.

### 3. Device pass on the iPhone 13 Pro

The phone (UDID `00008110-001C30661ABA401E`) is registered; the install commands are in
the `iphone-device-install` memory. Nothing has run on a physical device yet. Check:

- Pair by scanning a fresh QR from the Mac or a Linux agent, connect, relaunch, and
  confirm the Secure Enclave key still works.
- Local Network prompt: deny it and confirm the `local_network` error state shows, then
  allow it in Settings and confirm the connection.
- The launch screen in light mode. In the Release simulator build it showed black and
  then faded in; the bundled launch assets are correct, so this is probably a simulator
  quirk, but confirm on the device.
- NAT64: the runbook's Internet Sharing DNS64 setup, with an IPv4 literal and with a DNS
  name. Phase 13 lane e routes IPv4 literals through `getaddrinfo` on Apple so they get
  NAT64 synthesis; it is unit-tested, not tried on a real IPv6-only network.
- Face ID with App Lock on.

TestFlight is the easiest way to run this on the uploaded build. This is the main risk
left: a pairing or Secure Enclave bug found here means a code fix and a new build.

### 4. Submit for review

After the device pass, submit the build. Then record the approved build's protocol range
in `compat/mobile-protocol.json` and tag `mobile-v1.0.0` (runbook).

### Support contact (optional)

The support anchor at `/docs/iphone#support` points to GitHub issues. App Review accepts
that, but if you want an email address there, add it to the docs page; the run did not
put your address anywhere public.

## Before real hosts work fully

- Module-page history on the phone uses the `query.history.v1` host feature, which ships
  in the macOS app and agent after 0.15.0, still the latest release on 2026-11-25. A
  0.15.0 host connects and streams live data, but its module pages show the "needs a
  newer StatGlass" state until it updates. Cut the next macOS release (and agent) before
  or with the iPhone launch.
- Linux hosts inside a container show no network rows: the Linux collector skips veth
  interfaces on purpose. Not a phone bug.

## Known gaps, not blocking submission

- Light-mode contrast: the CPU and Network figure accents measure 3.68:1 and 3.77:1 on
  the card, and `--color-link` 3.68:1 on white, under the 4.5:1 minimum. They are design
  system tokens shared with the desktop, so changing them is a design decision.
- Per-host history retention is not sent to the phone, so the module page's range sheet
  caps at 7 days. Follow-up: carry `retention_days` to the phone.
- `statglass://debug` and the dev demo scenarios are hidden in release builds; in Debug
  builds `/debug` with demo mode lands on the welcome screen.
- The live process table adds about 0.8 kB/s per host over the full stream (measured
  1,598 B/s with it, 819 B/s without, against a Linux agent). Fine on Wi-Fi; worth
  batching if cellular use grows.
- A swiped host row (Settings, remove) stays open when you tap elsewhere on the list.
- A module page's two-line header clips its subtitle mid-word when the window is
  narrower than an iPhone 17, as in the iPad compatibility window ("Apple M4 Pro · 10
  performance + 4 efficiency core"). The title view in
  `apps/mobile/src/module/module-frame.tsx` has no width bound, so `adjustsFontSizeToFit`
  never shrinks it. Cosmetic; fine on the screenshot device.
- The phone's loading state (D-133, D-159) waits at most 10 s for the host's recent
  rows (`REFILL_WAIT_MS`); on cellular with live detail withheld, a chart shows its
  scan line for those 10 s and then what the ring holds.

## Repo housekeeping

- `updater-patch-test` fails in any worktree nested under the main checkout (Cargo finds
  the parent workspace). It passes from the main checkout; run it there.
- Under load, `historical-usage-card.test.tsx`, a WebKit treemap hover in
  `disk-space.spec.ts` and the engine GPU perf gate
  (`gpu_process_ticks_stay_within_allocation_and_call_budgets`, IOKit 352 calls/tick
  against 350) flake or fail on this machine; each passes alone or fails the same on main.
- A stash `p12-axis-verify` (one file, `packages/core/src/chart-math/axis-ticks.ts`, a
  debugging probe from phase 12) is left on the shared stash stack; drop it when
  convenient.
- The docs site build needed its `@core` alias moved to `packages/core` (fixed on main, in
  `docs-site/astro.config.mjs`).
- Tags `ios-app-phase-*` exist locally only; they were not pushed.
