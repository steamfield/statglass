# StatGlass for iPhone: App Store handoff

Status on 2026-11-25, when `deliver/ios-app` merged to main. The code for StatGlass for
iPhone 1.0.0 is done: RFC phases 0 to 4, the polish RFC (`plan/rfc-ios-polish.md`) and
App Store readiness (plan phase 13) all landed, the final whole-branch review ran and its
findings are fixed. What is left is signing, a device pass and App Store Connect work, all
of which need the maintainer. The release runbook is `.github/releasing-mobile.md`; this
file says what has and hasn't been done against it.

## Blocked on you, in order

### 1. Distribution certificate

`make mobile-archive` builds and signs `StatGlass.xcarchive`, but the App Store export
fails because this Mac has no "Apple Distribution" certificate for team `YWA9Q642YP`.
Creating one changes your Apple developer account, so the run left it to you. Either:

- In Xcode, Settings > Accounts > the team > Manage Certificates > + > Apple Distribution.
  Then rerun the archive.
- Or let Xcode create the certificate and the App Store profile during export by adding
  `-allowProvisioningUpdates` to the `xcodebuild -exportArchive` line in
  `scripts/mobile/archive.sh` (a one-line change; say so and an agent can make it).

Then, from a clean checkout of main:

```sh
make mobile-check
make mobile-archive
make mobile-release-check
```

`mobile-release-check` has not run against an exported IPA yet, only its fixtures
(`make mobile-release-check-test`). Read its Hermes signature line and the advisory
strings it prints.

### 2. Device pass on the iPhone 13 Pro

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

### 3. App Store Connect

Follow the checklist in `.github/releasing-mobile.md`. Decisions already made (D-156,
D-158): name StatGlass, Utilities with Developer Tools secondary, Data Not Collected,
`ITSAppUsesNonExemptEncryption` true with France excluded from availability, review
access through "Try demo hosts" only (the review notes are in the runbook).

Still to do: the store screenshots (five demo screens at 1206 x 2622, steps in the
runbook; none are made yet), the iPad compatibility-mode check, the age rating, and the
Accessibility Nutrition Labels.

### 4. Support contact

The support anchor at `/docs/iphone#support` points to GitHub issues. App Review accepts
that, but if you want an email address there, add it to the docs page; the run did not
put your address anywhere public.

## Before real hosts work fully

- Module-page history on the phone uses the `query.history.v1` host feature, which ships
  in the macOS app and agent after 0.15.0. A 0.15.0 host connects and streams live data,
  but its module pages show the "needs a newer StatGlass" state until it updates. Cut the
  next macOS release (and agent) before or with the iPhone launch.
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
- The docs site build needed its `@core` alias moved to `packages/core` (fixed on this
  branch, in `docs-site/astro.config.mjs`).
