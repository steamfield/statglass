---
name: ios-simulator
description: Run the StatGlass iPhone app in the iOS Simulator, screenshot it in light and dark and at several Dynamic Type sizes, and compare it against the desktop popover. Use after any change under apps/mobile/ that affects what a screen shows, before calling a mobile UI change done, and when a mobile screen renders blank or wrong.
---

# iOS Simulator check

Jest renders the React tree but computes no layout and draws nothing, so a mobile screen is
not done until it has been seen in the simulator and compared with the desktop popover, the
screen the phone's host screen is adapted from (RFC `plan/rfc-ios-app.md` 1.4). This is the
mobile half of `.claude/rules/verification.md`.

## 1. Build and launch

From the repo root, in this order:

```bash
bun install --frozen-lockfile
scripts/mobile/build-rust-ios.sh            # only when crates/ changed, or no XCFramework exists yet
bun run --cwd apps/mobile expo prebuild --platform ios   # regenerates the uncommitted ios/ project
bun run --cwd apps/mobile expo run:ios         # builds, boots a simulator, installs and starts Metro
```

`bun run --cwd` runs the package's `expo` binary without a `cd`, which worktree sessions
refuse. For JS-only changes after the first build, `bun run --cwd apps/mobile dev` starts Metro and
the installed app reloads. Rebuild with `expo run:ios` after any change to native code, the
XCFramework, `app.config.ts` or a dependency with native code.

`xcrun simctl list devices booted` shows the booted device. Use one current iPhone model for
comparisons and say which.

## 2. Screenshot

If the session has a simulator tool (an iOS Simulator MCP server or similar), attach it to
the booted device and take screenshots and taps through it, so you can also navigate. Without
one, use simctl and read the PNG:

```bash
xcrun simctl io booted screenshot <scratch-dir>/home-dark.png
```

Write screenshots to a scratch directory, never into the repository.

Cover at least:

- Both appearances: `xcrun simctl ui booted appearance light` and `... appearance dark`.
- Dynamic Type at the default (`xcrun simctl ui booted content_size large`), a large size
  (`extra-extra-extra-large`) and an accessibility size (`accessibility-extra-large`). Text
  must scale, wrap or truncate on purpose, and no touch target may shrink below 44 pt.
- Demo mode ("Try demo hosts") for anything that shows host data, so the screen has data
  without a paired host.
- Every state the change touches: loading, gap, not available, offline, and the specific
  error state from RFC section 3.

## 3. Compare against the desktop popover

1. Start the desktop on the mock transport: `bun run dev:fast`, then open the dev gallery at
   `/?route=/dev/gallery` (and the popover route if the change is the host screen).
2. Screenshot the matching desktop card or screen in the same appearance.
3. Put the two side by side and check what must match: card order, module accents, status
   colors, headline-value rule, gap rendering, number formats and wording. Spacing, radii,
   type sizes, chrome and interaction are allowed to differ (RFC 4.6).
4. Check `plan/design-system.md` for anything the popover does not show.

Name every difference you leave in place, and why, in the report or PR. "Looks the same"
without screenshots is not a comparison.

## Blank or wrong screen

- Read Metro's output and the simulator log first (`xcrun simctl spawn booted log stream
  --predicate 'process == "StatGlass"'`); a blank screen is often a thrown error.
- Sample the screenshot's colors at a few points. The navigator's default background means a
  screen mounted and drew nothing; the app's page background token means the screen is there
  and its content is invisible, which is a styling problem (NativeWind dropped a `className`
  on a component it does not know).
- A crash at launch after a Rust change usually means a stale XCFramework: rerun
  `scripts/mobile/build-rust-ios.sh` and `expo run:ios`.
