# Plan: Settings tabs and search

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.4/shared/scripts/plan_graph.py
Started: 2026-11-26. Timebox: none. Landing branch: deliver/settings-tabs.
Gate: `bun run check && bun run test:e2e` (check 85s; e2e measured at phase 1 landing). Filtered tests: `bun run test -- src/app/routes/dashboard/settings`. Typecheck: `bun run typecheck`.
Runner: plain commands.
Worktree setup: `bun install --frozen-lockfile`.
Suppressions: biome-ignore
Manifests:

## Spec

The dashboard Settings page grew to nine panels in two masonry columns. It becomes six tabs in one column, with search across every setting, following the approved prototype (https://claude.ai/artifact/BnSYXBYjQGKK6PvwYkiaBd). Every existing control keeps its copy, its Rust-owned setting and its one-patch write (D-050); this is a frontend regrouping.

In scope:
- Tabs, in order: General (Startup, Appearance, Units), Menu bar (one panel: Show menu-bar icon first, then preview, bars, values, separate items), Monitoring (Modules, Sampling), History (History, Clear history), Access (Other Macs, iPhones, Command line), About (Updates, Feedback).
- The tab is a path segment: `/dashboard/settings/<tab>`; bare `/dashboard/settings` and unknown tab segments show General. A row to focus is `?focus=<row id>`: the row scrolls into view and is highlighted once, and the param is removed (replace navigation) right after scrolling. A focus id whose row is not on the page yet is retried as the page renders for up to 3 s, then dropped.
- A path segment survives a cold open: Rust builds a new dashboard window from the route as its URL path (src-tauri/src/windows.rs:189), and `initialRoute` keeps only the pathname today. `initialRoute` also passes the window's query through for `/dashboard/...` paths, so focus survives too where the webview keeps it.
- Because the tab is in the pathname, tab changes reset `<main>`'s scroll and replay the page entrance through the existing pathname-keyed hooks (dashboard/route.tsx `useScrollTopOnNavigate`, `usePageEntrance`). Pathname checks that mean "the Settings page" use `isSettingsPath`.
- Tab bar: its own sticky band directly under the unchanged PageHeader (which keeps its 72 px hairline alignment with the sidebar brand row), Radix Tabs semantics, single-column content capped at 760 px.
- Show menu-bar icon moves into the Menu bar panel as its first row; while off, the rest of that panel is disabled and says why once.
- Appearance becomes a SegmentedControl (Match system, Light, Dark).
- Nested (indented) dependent rows: Sample interval and Slow down on battery under Performance mode; Install updates automatically under Check for updates; statglass command and Coding agents under Allow command-line access.
- History tab: Clear history in its own panel at the bottom with the existing confirm dialog; a storage meter above retention (phase 2).
- The Access tab label carries a bordered count of device updates waiting (pending or failed intents), sharing one query hook with the Device access rows.
- Every in-app link to Settings opens the tab its setting is on: the update notices and host update actions open About, the Network history hint opens History focused on `network-history`, the performance explainer in the sidebar and popover opens Monitoring focused on `performance-mode`.
- Phase 2: search, disabled-reason links, the history meter (see phase 2).

Out of scope: Reset to defaults; searching Alerts or Hosts settings; changing any Rust code or settings type; copy changes beyond the section titles below and the Units "Shows as" lines; the prototype's "What it changes" disclosure (D-088 keeps the Performance mode changes always visible).
Assumptions:
- iPhone pairing stays independent of Allow remote monitoring (unconfirmed dependency, left as in the prototype).
- Section titles: Startup, Appearance, Units, Menu bar, Modules, Sampling, History, Clear history, Other Macs, iPhones, Command line, Updates, Feedback.
- The paired-device list, the menu-bar preview, HistoryNotices and DeviceIntents' per-intent rows are section context, not catalog rows: they carry no row id and show whenever their section shows.
Error model: settings writes keep `useWriteSettings` and its existing error toast. Location parsing never fails: an unknown tab shows General, an unknown or never-rendered focus id is dropped silently. The device-intents query keeps today's behavior (no retry, error shown in the Device access row); the tab count shows nothing while it is pending or failed. Search has no failure path. The history meter shows `MISSING` figures while its queries are pending or failed; HistoryNotices keep reporting store health.

## Contracts (scaffold commit)

Layout:

    src/app/lib/settings-links.ts      SETTINGS_TABS, SettingsTabId, settingsHref, parseSettingsLocation, isSettingsPath; pure, shared by every route that links to Settings
    src/app/routes/initial-route.ts    (existing) passes the query through for dashboard paths
    src/app/routes/dashboard/settings/
      route.tsx                        wiring: PageHeader, tab bar, active tab content, focus hook; no logic
      _lib/catalog.ts                  SETTINGS_CATALOG: sections and rows per tab with search keywords; pure data
      _hooks/use-device-intents.ts     the one device-intents query (10 s refetch, no retry)
      _hooks/use-focus-row.ts          finds the focused row as the page renders, scrolls, flashes, clears the param
      _components/settings-tabs.tsx    sticky tab bar (Radix Tabs list) with the Access count
      _components/tab-content.tsx      maps a SettingsTabId to its tab component
      _components/tabs/<id>-tab.tsx    one per tab, composing that tab's panels from settings
      _components/startup-panel.tsx    Launch at login, Show in Dock
      _components/appearance-panel.tsx Appearance segmented control
      _components/units-panel.tsx      Temperature, Network rate, Memory
      _components/updates-panel.tsx    Version, Check for updates, Install updates (nested)
      _components/feedback-panel.tsx   Feedback & issues, Support StatGlass
      _components/remote-panel.tsx     Allow remote monitoring
      _components/history-panel.tsx    retention, size limit, network history, HistoryNotices
      _components/clear-history-panel.tsx history on disk and Clear with confirm
      (existing, changed) sampling-panel.tsx, modules-panel.tsx, menu-bar-panel.tsx, command-line-panel.tsx, paired-devices/, device-intents/, update-row.tsx
      (deleted) general-panel.tsx

Implemented in the scaffold (pure or tiny, needed by several lanes): `~/lib/settings-links.ts`, `_lib/catalog.ts`, `_hooks/use-device-intents.ts`, the `initialRoute` query pass-through, `tab-content.tsx`, the six `tabs/<id>-tab.tsx` compositions, and a minimal `route.tsx` (PageHeader plus the active tab). New panels are stubs returning null. The code the old route held inline (UnitsPanel, the remote monitoring panel) is at `git show 8bce8031:src/app/routes/dashboard/settings/route.tsx`.

```ts
// ~/lib/settings-links.ts
export const SETTINGS_TABS: readonly { id: SettingsTabId; label: string }[]; // general, menu-bar, monitoring, history, access, about
export type SettingsTabId = "general" | "menu-bar" | "monitoring" | "history" | "access" | "about";
export function settingsHref(tab: SettingsTabId, focus?: string): string; // "/dashboard/settings/<tab>[?focus=<id>]"
export function parseSettingsLocation(pathname: string, search: string): { tab: SettingsTabId; focus: string | null };
export function isSettingsPath(pathname: string): boolean; // "/dashboard/settings" and "/dashboard/settings/..."

// _hooks/use-device-intents.ts
export function useDeviceIntents(): UseQueryResult<DeviceIntentInfo[]>;
```

Shared component changes in the scaffold:
- `~/components/settings-row.tsx`: `SettingsRow` gains `id?: string` (rendered as `data-settings-row`) and `nested?: boolean` (32 px left inset with a hairline connector from the row above). `SettingsPanel` gains `id?: string` (rendered as `data-settings-section`).
- `~/components/page-header.tsx`: `headerRef?: Ref<HTMLElement>` on the sticky header element.
- `~/components/module-toggle-list.tsx`: `ModuleToggleRow` gains `rowId?: string` rendered as `data-settings-row`.
- `src/app/router.tsx`: the settings route becomes `settings/:tab?`.

Row ids are the `id`s in `SETTINGS_CATALOG`. Each catalog row's element carries `data-settings-row="<id>"` exactly once while its tab shows; the menu-bar blocks wrap their field label and rows in one element with the block's id (those rows use the panel's own `ROW` class, which has no `last:` border rule).

## Phases

### Phase 1: Tabs and regrouped panels (MVP)

Demo: `bun run dev:fast`, open `/?window=dashboard&route=/dashboard/settings`, switch tabs; open `/?window=dashboard&route=/dashboard/settings/monitoring%3Ffocus%3Dsample-interval`.
Test cases (scaffold: `settings/tabs.test.tsx`, `~/lib/settings-links.test.ts`, `initial-route.test.ts`, and the existing settings tests moved to their tabs):
- The six tabs render in order; bare path opens General with Startup, Appearance and Units and no Sampling.
- `/dashboard/settings/nope` opens General; `/dashboard/settings/history` opens History.
- Clicking a tab navigates to `/dashboard/settings/<tab>`; ArrowRight/ArrowLeft move the selection.
- For each tab, every catalog row id of that tab appears exactly once as `data-settings-row`, each section id once as `data-settings-section`, and no row id of another tab appears.
- `focus=sample-interval` on Monitoring scrolls that row into view, marks it `data-flash`, and the URL loses `focus`; an unknown focus id is dropped without scrolling.
- The Access tab's accessible name says "2 device updates waiting" with the mock's two intents.
- Appearance's segmented control writes `{ general: { appearance: "dark" } }`.
- Show menu-bar icon is on Menu bar, writes `{ general: { show_menu_bar: false } }`, then disables the readout switches and separate-item selects and shows "Turn on Show menu-bar icon to change what it shows."
- Install updates automatically is disabled with "Needs Check for updates automatically." while Check for updates is off.
- Clear history… opens the "Clear history?" confirm and only then calls `clear_history`.
- `settingsHref`, `parseSettingsLocation` and `isSettingsPath` cover defaults, unknown tabs, empty focus and the bare path.
- `initialRoute` keeps a dashboard window's query (`?focus=…`).
- The existing route.test.tsx, reset-history, command-line-panel and update-row behaviors pass from their tabs ("Turn on Power & Sensors in Monitoring to use this" replaces "…in Modules…").
- E2E specs that open Settings are moved to their tabs at landing (owned by the landing step, not a lane).

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/app/routes/dashboard/settings/route.tsx, src/app/routes/dashboard/settings/_hooks/use-focus-row.ts, src/app/routes/dashboard/settings/_components/settings-tabs.tsx, src/app/styles/motion.css, src/app/routes/dashboard/route.tsx, src/app/components/host-switcher.tsx | contracts, src/app/components/segmented-control.tsx, src/app/hooks/use-element-size.ts | src/app/routes/dashboard/settings/tabs.test.tsx | opus | pending | | tabs tests for shell, focus and count pass |
| b | M | src/app/routes/dashboard/settings/_components/startup-panel.tsx, src/app/routes/dashboard/settings/_components/appearance-panel.tsx, src/app/routes/dashboard/settings/_components/units-panel.tsx, src/app/routes/dashboard/settings/_components/updates-panel.tsx, src/app/routes/dashboard/settings/_components/feedback-panel.tsx, src/app/routes/dashboard/settings/_components/remote-panel.tsx, src/app/routes/dashboard/settings/_components/general-panel.tsx, src/app/routes/dashboard/settings/_components/update-row.tsx, src/app/routes/dashboard/settings/_components/command-line-panel.tsx, src/app/routes/dashboard/settings/_components/paired-devices/, src/app/routes/dashboard/settings/_components/device-intents/, src/app/routes/dashboard/settings/_components/update-from-mac/ | contracts | src/app/routes/dashboard/settings/_components/command-line-panel.test.tsx, src/app/routes/dashboard/settings/_components/update-row.test.tsx | sonnet | pending | | typecheck and panel tests pass |
| c | M | src/app/routes/dashboard/settings/_components/sampling-panel.tsx, src/app/routes/dashboard/settings/_components/history-panel.tsx, src/app/routes/dashboard/settings/_components/clear-history-panel.tsx, src/app/routes/dashboard/settings/_components/modules-panel.tsx, src/app/routes/dashboard/settings/_components/menu-bar-panel.tsx, src/app/routes/dashboard/settings/_components/tabs/monitoring-tab.tsx | contracts | | opus | pending | | typecheck passes |
| d | S | src/app/routes/dashboard/_components/host-update-notice.tsx, src/app/routes/dashboard/network/_components/apps-now-card.tsx, src/app/routes/dashboard/hosts/_components/host-card-actions.tsx, src/app/routes/dashboard/_components/live-sidebar.tsx, src/app/routes/popover/route.tsx, src/app/routes/popover/_components/popover-options.tsx, src/app/components/popover-header.tsx, src/app/routes/dev/gallery/_sections/app-components.tsx | contracts | | sonnet | pending | | typecheck and those routes' tests pass |

Route-level tests (tabs.test.tsx, route.test.tsx, reset-history.test.tsx) need lanes a, b and c together; each lane runs them after rebasing its own diff onto nothing else, so expect failures in cases owned by other lanes, and the landing step runs them on the merged result.

#### Lane a brief

- Goal: the tab shell. Settings reads its tab and focus from the location, shows a sticky tab bar under the page header, renders the active tab's panels, scrolls to and flashes a focused row, and pathname checks treat every Settings tab as the Settings page.
- Interface: use `parseSettingsLocation`, `settingsHref`, `SETTINGS_TABS`, `isSettingsPath` from `~/lib/settings-links`, `useDeviceIntents` from `_hooks/use-device-intents`. Implement the scaffold stubs `useFocusRow(focus: string | null, onDone: () => void): void` and `SettingsTabs({ value: SettingsTabId; onValueChange(tab): void })`, and finish `route.tsx`. `TabContent({ tab })` and the per-tab compositions already exist; don't change them.
- Behavior:
  - `route.tsx`: `PageHeader title="Settings" headerRef={…}`, then `SettingsTabs`, then `TabContent` in a `max-w-[760px]` column with panels 20 px apart and `data-enter-group` on the content like today. Tab change: `navigate(settingsHref(tab))`.
  - Sticky offsets: measure the header and the tab bar heights (`useElementSize` from `~/hooks/use-element-size`, or a ResizeObserver guarded like it), place the tab bar at `top: <header height>px` with `z-10` and `bg-background`, and set `--settings-sticky-top` (header plus tab bar height, px) on the route root for the menu-bar preview (lane c reads it).
  - Tabs: Radix Tabs from the existing `radix-ui` package (`import { Tabs as TabsPrimitive } from "radix-ui"`, as `~/components/ui/toggle-group.tsx` imports its primitive), controlled `value`, `activationMode="automatic"`; only the list lives in `SettingsTabs`, and the content is rendered by `TabContent` with `role="tabpanel"` and `aria-labelledby` the active tab's id. 13 px medium labels, muted inactive, foreground active, a 2 px foreground underline on the active tab that slides over `--motion-fast` with `--ease-out` inside `prefers-reduced-motion: no-preference`; the bar has a bottom hairline (`border-border-subtle`); no cyan. No new dependencies.
  - Access count: `useDeviceIntents().data?.length`; when above zero, a bordered count after the label in the sidebar attention style, and the tab's accessible name becomes "Access, N device updates waiting" ("1 device update waiting" for one). Nothing while pending, failed or zero.
  - `useFocusRow`: whenever `focus` is set, look for `[data-settings-row="<focus>"]` after each render and with a MutationObserver on the route root, for up to 3000 ms. When found: `scrollIntoView({ block: "center" })`, call `onDone` at once (route clears `focus` with `navigate(settingsHref(tab), { replace: true })`), and set `data-flash` on the element for 1400 ms independently of the URL. Not found by the deadline: call `onDone`. Clean up the observer and timers on unmount and when `focus` changes.
  - `[data-flash]` styling in `src/app/styles/motion.css`: inside `prefers-reduced-motion: no-preference` and outside `[data-performance]`, a keyframe from `color-mix(in srgb, var(--color-primary) 14%, transparent)` background to transparent over 1400 ms; otherwise a static `--color-selected` background while the attribute is set.
  - `src/app/routes/dashboard/route.tsx` and `src/app/components/host-switcher.tsx`: replace the `"/dashboard/settings"` equality checks with `isSettingsPath(pathname)`. Change nothing else in those files.
- Decisions already made: path segment for the tab, query for focus. Page title "Settings", no subtitle. PageHeader stays as it is.
- Out of scope: search, panel internals, link call sites (lane d).
- Done when: the shell, focus and count cases in `bun run test -- src/app/routes/dashboard/settings/tabs.test.tsx` pass (panel-content cases need lanes b and c), `bun run typecheck` passes (panel stubs from the scaffold keep it green), check-lane is clean.

#### Lane b brief

- Goal: split the General panel and the inline route panels into the General, Access and About tab panels, and tag their rows for the catalog.
- Interface: implement the scaffold stubs `StartupPanel({ general })`, `AppearancePanel({ general })`, `UnitsPanel({ units })` (today's `UnitsPanel` body from the old route, see Contracts), `UpdatesPanel({ general })`, `FeedbackPanel()`, `RemotePanel({ enabled })` (the old route's remote monitoring row). Delete `general-panel.tsx`. Each panel passes its catalog section id to `SettingsPanel id`, each row its catalog row id to `SettingsRow id`.
- Behavior:
  - Startup (`startup`): Launch at login (`launch-at-login`), Show in Dock (`show-in-dock`), same switches and labels. Show menu-bar icon moves to lane c.
  - Appearance (`appearance`): one row (`appearance`) with `SegmentedControl` options Match system / Light / Dark (values `system`, `light`, `dark`), `ariaLabel="Appearance"`, writing `{ general: { appearance } }`.
  - Units (`units`): today's three controls (`temperature-unit`, `network-unit`, `memory-unit`), each with a sub line "Shows as <example>" formatted with the app's own formatters from `@core/format` for 52 °C, 3.2 MB/s and 36 GB in the selected unit (read the formatters first and use them; no hand-built strings).
  - Updates (`updates`): `UpdateRow` first (id `version`, set inside update-row.tsx), Check for updates automatically (`check-updates`), then Install updates automatically (`install-updates`, `nested`), disabled while checking is off with sub "Needs Check for updates automatically." and the existing restart sentence otherwise.
  - Feedback (`feedback`): the two CommunityRows rows (`feedback`, `support`), unchanged.
  - Other Macs (`remote`): the Allow remote monitoring row (`remote-monitoring`) moved from the old route, same copy and switch.
  - Paired devices panel: title "iPhones", section id `iphones`; rows `iphone-access`, `iphone-host-list` (UpdateFromMac), `device-access` (DeviceIntents' first row). The device list keeps today's markup and carries no row id.
  - DeviceIntents uses `useDeviceIntents()` instead of its own `useQuery`; its retry mutation refetches that query as today.
  - Command line (`command-line`): `command-line-access`, `statglass-command` (nested), `coding-agents` (nested).
- Decisions already made: copy is unchanged except the section titles in the spec and the Units "Shows as" lines.
- Out of scope: tab composition and the route (lane a), Monitoring, History and Menu bar panels (lane c), search.
- Done when: `bun run test -- src/app/routes/dashboard/settings/_components` and `bun run typecheck` pass, check-lane is clean.

#### Lane c brief

- Goal: regroup the Monitoring, History and Menu bar panels.
- Interface: change `SamplingPanel` to `({ sampling })` (drop `history`, and stop passing it in `tabs/monitoring-tab.tsx`), implement the stubs `HistoryPanel({ history })` and `ClearHistoryPanel()`, make `MenuBarPanel`'s `general` prop required (the tab already passes it), use `ModuleToggleRow`'s `rowId` (already added).
- Behavior:
  - Sampling (`sampling`): Performance mode (`performance-mode`, its always-visible changes list unchanged), Sample interval (`sample-interval`, `nested`), Slow down on battery (`slow-on-battery`, `nested`). HistoryNotices move to HistoryPanel's `after`.
  - History (`history`): Keep history (`keep-history`), History size limit (`history-size-limit`), Network history (`network-history`, still only with per-app network). Same projections and copy as today.
  - Clear history (`clear-history`, one row `clear-history`): label "Clear history", sub "<size> of recorded history on this Mac." from the existing size query (`MISSING` while unknown), button "Clear history…" (outline, destructive text) opening the existing ConfirmDialog with its copy unchanged, disabled at size 0.
  - Modules (`modules`): `rowId={"module-" + m}` for each of `SETTINGS_MODULES`.
  - Menu bar (`menu-bar`): first row Show menu-bar icon (`show-menu-bar-icon`), the switch and its sub moved unchanged from the old General panel. While it is off: one line "Turn on Show menu-bar icon to change what it shows." under that row, the bars toggle group, value switches and separate-item selects disabled, and the preview kept. Wrap blocks with row ids: bars `menu-bar-bars`, values (field label plus rows) `menu-bar-values`, separate items (label, rows, footnote) `menu-bar-items`. The sticky preview uses `top: var(--settings-sticky-top, 0px)`.
  - A module that is off keeps today's disabled text, with "Monitoring" in place of "Modules": "Turn on Power & Sensors in Monitoring to use this".
- Decisions already made: the link on "Monitoring" comes in phase 2.
- Out of scope: the history meter (phase 2), tab composition, search.
- Done when: `bun run typecheck` passes and check-lane is clean; route-level cases are verified at landing.

#### Lane d brief

- Goal: every in-app link to Settings opens the tab its setting lives on.
- Interface: `settingsHref(tab, focus?)` from `~/lib/settings-links`.
- Behavior:
  - `host-update-notice.tsx`: both `/dashboard/settings` hrefs become `settingsHref("about")`.
  - `host-card-actions.tsx`: the `settings` action navigates to `settingsHref("about")`.
  - `apps-now-card.tsx`: the Network history hint links to `settingsHref("history", "network-history")`.
  - `live-sidebar.tsx`: the performance explainer's `onOpenSettings` navigates to `settingsHref("monitoring", "performance-mode")`. The sidebar entry's `href` stays `/dashboard/settings`.
  - `popover-header.tsx` passes `onSettings` to both the gear button (line 86) and the performance explainer's `onOpenSettings` (line 61). Add an `onPerformanceSettings: () => void` prop for the explainer; `popover/route.tsx` passes `() => void transport.openDashboard(settingsHref("monitoring", "performance-mode"))`. The gear button and `popover-options.tsx`'s Settings item keep `/dashboard/settings`. Update the dev gallery's `PopoverHeader` (`routes/dev/gallery/_sections/app-components.tsx`) to pass it too, and point that file's Settings link (line 212) at `/dashboard/settings` unchanged unless it names a setting.
- Out of scope: everything under `routes/dashboard/settings/`.
- Done when: `bun run typecheck` and `bun run test -- src/app/routes/dashboard/_components src/app/routes/popover src/app/routes/dashboard/network src/app/routes/dashboard/hosts` pass (fix nothing outside your files; report a test that asserts the old href), check-lane is clean.

### Phase 2: Search, links and the history meter

Demo: `bun run dev:fast`, Settings, press ⌘F, type "dark", "refresh", "ssh"; turn CPU off and follow the link from Menu bar; open History.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/app/routes/dashboard/settings/_lib/search.ts, src/app/routes/dashboard/settings/_components/settings-search.tsx, src/app/routes/dashboard/settings/_components/search-results.tsx, src/app/routes/dashboard/settings/route.tsx | contracts | | opus | pending | | |
| b | M | src/app/routes/dashboard/settings/_components/history-meter.tsx, src/app/routes/dashboard/settings/_components/history-panel.tsx, src/app/routes/dashboard/settings/_components/menu-bar-panel.tsx | contracts | | sonnet | pending | | |

Notes for the phase 2 briefs, from the plan critique: search shows only matching catalog rows while untagged section context (preview, notices, device list) stays with its section; a matching nested row whose parent is hidden must not draw an orphan connector; hiding rows must not leave a doubled or missing hairline at a panel's end.

## Log

- Plan written from the approved prototype; the user approved the design and asked for merge to main, cleanup and push when production ready.
- Plan critique (opus) findings applied: the tab moved from a query param to a path segment because a cold-opened dashboard window keeps only its pathname (windows.rs:189, initial-route.ts:21), which also gives tab changes the existing scroll reset and entrance; `initialRoute` passes the query through; E2E specs are moved at landing; other Settings links (host update notice, host card action, apps-now card, sidebar and popover explainers) get lane d; route.test.tsx is scaffold-owned and verified at landing; `useFocusRow` retries until the row renders and clears the param right after scrolling; the paired-device list and other section context carry no row id, so no wrapper breaks `last:` hairlines; PageHeader keeps its 72 px hairline and the tab bar is its own sticky band; one `useDeviceIntents` hook shares query options; the count says "waiting", since failed intents count. Phase 2 search-filter concerns (orphan connectors, hairlines) carried into its brief notes.
