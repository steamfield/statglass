# Plan: global chart window on iPhone

Skill: sprint. Profile: sprint. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.6/shared/scripts/plan_graph.py
Status: done. Started: 1795812959. Timebox: none. Landing branch: sprint/global-chart-window.
Gate: `make mobile-check` plus `bun run lint`. Filtered tests: `bun run --cwd apps/mobile test -- <path>` (full mobile suite is ~10 s, lanes may run it). Typecheck: `bun run --cwd apps/mobile typecheck`.
Runner: plain commands.
Worktree setup: `bun install --frozen-lockfile`.

## Spec

The Mac saves one chart window (`general.chart_window`) that every module page follows, picked from a control at the top right of each page. The iPhone keeps its range in per-page local state that resets to 1h on every visit, and its host page cards always show the last minute. This build gives the phone one saved window that every module page and the host page's card charts follow until changed, set from a control in the navigation bar's top right on those screens.

In scope:
- One window in the phone's own settings (`PhoneSettings.chartWindowMs`), shared by all hosts and screens, persisted across launches.
- Fresh install starts at the Mac default, `DEFAULT_CHART_WINDOW` (15m).
- The control is a segmented `15m | 1h | More` in the navigation bar's top right. More opens the existing preset sheet (`PHONE_RANGES`, 5m to 7d) and shows the chosen label (for example `6h`) while a non-quick window is selected.
- The control is on all six module pages and on the host page (pager).
- Host page card charts (CPU stream, GPU stream, Network mirror bars) follow the window: live ring where it covers the window, stored history for older time, stitched so the newest time stays live at 1 Hz.

Out of scope: custom durations and fixed date ranges, back navigation, per-host windows, following the Mac's own setting, slow-interval clamping of short windows (`effectiveWindow`), the hosts list row sparklines, making module page hero charts live.

Assumptions: the Settings screen gets no row for the window (the user chose the top-right control). Memory, Power and Battery cards have no time chart, so they don't change.

Error model: an invalid stored `chartWindowMs` makes `readSettings` throw like any other invalid field, so the phone falls back to defaults and logs once (existing behavior). A failed card history read leaves the older part of the card chart empty (null slots, drawn as missing) while the live part keeps drawing; cards show no error text. Module page history errors are unchanged.

## Contracts (scaffold commit)

    apps/mobile/src/
      data/chart-window.ts     PHONE_RANGES (moved from history.ts), DEFAULT_CHART_WINDOW_MS, isPhoneRange
      data/phone-settings.tsx  PhoneSettings.chartWindowMs, default and validation
      data/card-window.ts      (lane 1/b, new) stitches live ring and history into a card's slots

Read and write the window with the existing store API: `usePhoneSettings((s) => s.chartWindowMs)` and `usePhoneSettingsActions().set({ chartWindowMs })`.

## Phases

### Phase 1: one saved window, set from the top right, followed by module pages and host cards (MVP)

Demo: `bun run --cwd apps/mobile dev`, open a host, pick 1h top right, open CPU then Memory (both 1h), relaunch (still 1h); host page CPU card caption reads `1h`.
Scaffold: 05b57748
Test cases:
- Module page shows `15m, History range` selected on a fresh install and requests 15 minutes of history.
- Picking 1h on CPU, then opening Memory, shows 1h selected and requests an hour.
- Picking a preset from More (6h) selects More labelled `6h`; reopening any module shows 6h.
- The control renders in the navigation bar's right items, not in the page body.
- Host page shows the same control; changing it there updates the settings store and module pages.
- Host CPU card at 5m or shorter-than-ring windows draws from the live ring only and makes no history request.
- Host CPU card at 15m with only 5 minutes of ring requests `cpu.total` history covering the window, and draws history values in older slots and ring values in newer ones.
- History reply null buckets stay null (no interpolation); a failed history read leaves older slots null while ring slots draw.
- Card caption (`windowLabel`) and accessible label span follow the chosen window.
- Network bars follow the window with the same stitch for `net.tx_total` and `net.rx_total`.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/src/module/, apps/mobile/src/ui/segmented-control.tsx, apps/mobile/src/host/index.tsx, apps/mobile/test/module/, apps/mobile/test/helpers/module-screen.tsx, apps/mobile/test/navigation/headers.test.tsx, apps/mobile/test/app/reviewer-path.test.tsx, apps/mobile/test/ui/interaction/segmented-control.test.tsx, apps/mobile/test/host/range-header.test.tsx, apps/mobile/test/data/host-history.test.tsx, apps/mobile/test/demand/screen-demand.test.tsx | contracts, src/app/components/window-control.tsx, apps/mobile/src/app/(hosts)/index.tsx | | opus | merged | foreman/chart-window-header | lane a cases pass, mobile suite and typecheck green |
| b | M | apps/mobile/src/data/card-window.ts, apps/mobile/src/data/live-stream.ts, apps/mobile/src/data/live-subscription.ts, apps/mobile/src/host/live-card.tsx, apps/mobile/test/cards/, apps/mobile/test/host/host-screen.test.tsx, apps/mobile/test/host/card-stack.test.tsx, apps/mobile/test/data/card-window.test.tsx | contracts, src/app/hooks/use-module-series.ts, apps/mobile/src/data/history.ts | | opus | merged | foreman/chart-window-cards | lane b cases pass, mobile suite and typecheck green |

Both lanes write their own tests (deviation from the template: the existing jest harness is large, and each lane owns the test files it changes). Test files under a lane's Owns are its to edit.

#### Lane a brief

- Goal: make the module pages' range global and persisted, and move the range control into the navigation bar's top right on the six module pages and the host page.
- Interface: read `usePhoneSettings((s) => s.chartWindowMs)`, write `usePhoneSettingsActions().set({ chartWindowMs })` (`@/data/phone-settings`). Presets from `PHONE_RANGES` in `@/data/chart-window`. `useModulePage(host, remote)` drops its `defaultRange` argument and returns `windowMs`/`setWindowMs` backed by the setting. `ModulePageProps` drops `range`; `module/index.tsx` stops passing `HOUR_MS`.
- Behavior:
  - `RangeControl` segments become `15m | 1h | More` (values `15 * MINUTE_MS`, `HOUR_MS`, More). More shows `windowLabel(value)` when the value isn't 15m or 1h; selecting More opens the existing `Sheet` titled "History range" with every `PHONE_RANGES` row, checkmark on the current one. Accessible names stay `<label>, History range`.
  - The control goes in the navigation bar's top right through `Stack.Screen` options, following the pattern in `apps/mobile/src/app/(hosts)/index.tsx` (`headerRight` plus `unstable_headerRightItems` with a `custom` item, `hidesSharedBackground: true`). Remove it from the page body in `ModuleFrame`. `ModuleHost`'s loading screen doesn't need it.
  - The segmented control needs a fixed width in the bar (it sizes itself from `onLayout`); give it a compact header size via a prop on `ui/segmented-control.tsx` if needed, keeping touch targets at least 44 pt tall per segment hit area (hitSlop is acceptable) and capping Dynamic Type scaling the way `module-frame.tsx` caps the header title (`HEADER_MAX_SCALE`).
  - The host page (`host/index.tsx`, `HostScreen`) gets the same control in its top right, writing the same setting.
  - Changing the window anywhere updates every mounted page (it is one store value). Keep `useRefreshOnRangeChange` behavior.
  - Update existing module tests that assume a 1h default or the in-body control; the default is now 15m.
- Decisions already made: phone-local, all hosts; 15m default; presets only; control on module pages and host page.
- Out of scope: card chart behavior (lane b), a Settings row, custom ranges, changing `data/` files.
- Done when: test cases 1 to 5 have tests (host header in `test/host/range-header.test.tsx`), `bun run --cwd apps/mobile test` and `bun run --cwd apps/mobile typecheck` pass, and `bunx biome check apps/mobile` is clean for your files. `test/host/host-screen.test.tsx` belongs to lane b; if your header change breaks it, report which assertion instead of editing it.

#### Lane b brief

- Goal: host page card charts follow the saved window, drawing the live ring where it covers and stored history for older time, so the newest slots stay live at 1 Hz.
- Interface: new `apps/mobile/src/data/card-window.ts` exporting a hook used by `useCompactStream` and `useNetworkBars` in `data/live-stream.ts`, for example `useCardWindow(host, keys, windowMs, slots)` returning per-key `(number | null)[]` of `slots` buckets ending at the live edge plus `bucketMs`, `tEndMs`, `loading`. Keep its pure stitching function exported separately (inputs: ring samples per bucket, a `historyGrid` result, bucket bounds; output: slot values) so tests reach it without React. Read the window with `usePhoneSettings((s) => s.chartWindowMs)` inside `live-card.tsx` (or the hooks) and pass it down. History through `useHostHistory(host, selection, range, width, null, connected)` and `useHistoryRange` from `@/data/history`, grid via `historyGrid` from `@core/history-grid`. Export `PHONE_BACKFILL_MS` from `live-subscription.ts` if you need it.
- Behavior:
  - Slot count stays near today's density (CPU/GPU stream about 60 slots, network 48 bars); `bucketMs = max(intervalMs, windowMs / slots)`. Ring samples in a bucket are averaged (measured values only; a bucket with none is null). Use `visitWindow`/`seriesWindow` from `@core/live-state` rather than reading columns by hand.
  - When the ring covers the whole window (oldest ring timestamp at or before `edge - windowMs`), make no history request. Otherwise request history for the window with `max_points` equal to the slot count, and fill each slot older than the ring's oldest timestamp from the history bucket containing the slot's midpoint. Null history buckets stay null; never interpolate.
  - `loading` is true while history is pending and needed, so the chart scans as it does today. A failed history read: older slots null, ring slots draw, no thrown error; log nothing per frame.
  - Captions and accessible names use the chosen window: `windowLabel(windowMs)` and `chartLabel({ spanMs: windowMs })`. Nice ceilings keep their per-window scope keys.
  - The selector work per 1 Hz frame stays proportional to the window's ring rows; keep the existing equality and caching so unrelated frames don't re-render the card.
  - Update existing card tests that assume a one-minute window (the default is now 15m; tests may pass `settings: { chartWindowMs: ... }` to `renderWithProviders`).
- Decisions already made: the window is global; cards follow it, including windows beyond the ring (up to 7d).
- Out of scope: module pages and the range control (lane a), `host/index.tsx`, the hosts list sparklines, Rust or core changes.
- Done when: test cases 6 to 10 have tests (stitch unit tests in `test/data/card-window.test.tsx`, card behavior in `test/cards/`), `bun run --cwd apps/mobile test` and `bun run --cwd apps/mobile typecheck` pass, `bunx biome check apps/mobile` clean for your files.

## Log
- Lanes moved from Claude builders to Codex via foreman at the user's request (runs `chart-window-header` = 1/a, `chart-window-cards` = 1/b, model gpt-6.2-sol). Contracts in the session scratchpad. Codex leaves work uncommitted; the orchestrator reviews, commits on the lane branch and merges.
- Plan critique: accepted GPU coverage for cards (added to cases 6 and 7) and clarified case 6 (ring covers the window, pin the equality edge). Rejected: persistence and invalid-value tests missing (scaffold has them in test/settings/persistence.test.tsx); `settings` option unsupported (it takes Partial<PhoneSettings>). host-screen.test breakage from lane a is fixed by the orchestrator at landing.
- 1/a merged (5446b7da). Accepted: approved one-line edit to test/demand/screen-demand.test.tsx; reselecting the current range skips the write; module scroll top padding dropped since the control left the body. host -> module import of rangeHeaderOptions accepted (one shared control).
- 1/b merged (85e82fba). Accepted: 60/48 target buckets capped by cadence; a bucket touching the ring takes the ring value; paused host pins history to the last live sample; empty paused ring shows stored history. Codex review findings 2-5 fixed with regression tests; finding 1 (held fills) kept per orchestrator answer.
- Simulator: the two-line module title overlapped the header control, so the subtitle moved into the page body (74b53f2f); two header-role assertions went with it.
- Final review (opus, whole diff): fixed 1 (card buckets moved with the live edge; now a fixed grid ending at the newest bucket, ceiling decays on the 1 Hz edge), 2 (history requested only when a bucket ends before the ring, the stitch's rule), 3 (a failed refresh keeps the last good reply) and 4 (tests for closed-bucket stability, a short ring and a failed refresh, each revert-verified), in 533bd9da. Rejected 5 (splitting useCardWindow: a second hook with one caller), 6 (useConnection answers a UI-state question layered on remote status; the card needs a ring-level boolean) and 7 (moot: the subtitle commit removed module-frame's copy of the cap). Gate: make mobile-check 695 tests, lint clean.
