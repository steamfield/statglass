# RFC: StatGlass for iPhone, design and UX parity

Status: Draft, 2026-11-25, revised after the architecture, error and test audits. It is waiting
for a devil's-advocate review. Lanes for phases 10 to 12 go into `plans/deliver-ios-app.md`
only after that review. The foundation (plan phase 7) and pairing (plan phase 8) are already
written in full in the plan. This RFC says what they settle for the polish work.

Related: [iPhone RFC](rfc-ios-app.md) (section numbers below refer to it), [design system](design-system.md),
[decisions](decisions.md) (D-152 history from the host, D-153 network addresses), the run plan
`plans/deliver-ios-app.md` (phases 7 to 9).

## 1. Problem

The phone app works end to end (RFC phases 0 to 4), but it does not look or behave like
StatGlass. A simulator audit on 2026-11-25 (iPhone 18 Pro, demo hosts, light and dark) compared
it with the desktop popover, `design-system.md` and RFC 1.4, and found:

| # | Finding |
| - | ------- |
| 1 | Host screen reserves an empty large-title band (`headerLargeTitle` with `title: ""`), the "massive top padding"; the in-content title then slides under the back button |
| 2 | Native headers ignore the theme: the module title is black on near-black in dark mode |
| 3 | Header buttons are default glass chrome, not the design system's ("top nav buttons that feel off") |
| 4 | Titles render at weight 700; the design system stops at 590 |
| 5 | Card type far above RFC 1.4's mapping: one card fills a third of the screen, the popover fits four |
| 6 | Headline figures are not SF Pro Rounded tabular |
| 7 | Card header has no 8 pt accent swatch; a chevron competes with the value |
| 8 | CPU ceiling label floats 40 pt above the plot |
| 9 | Memory card: no "Pressure · normal" line, uneven 2x2 legend |
| 10 | Power card on Linux draws an empty bar and four dashes |
| 11 | "GPU not available" takes a full card |
| 12 | Network bars chunky, full-saturation, no ramp or labels |
| 13 | Live demo chart shows a gap on a Live host |
| 14 | Every demo host shows the same values and sparkline |
| 15 | Offline rows look live |
| 16 | Row sparkline is a flat line on the floor; values not tied to accents |
| 17 | "Demo" header text has no affordance |
| 18, 18b | Module page is a bare 0-100 % chart with no axis, stats or scrubbing affordance; it should carry the dashboard module page's content |
| 19 | Range control is a custom bordered segmented control |
| 20 | Welcome screen reads as a placeholder |
| 21 | Settings back button differs from other headers |
| 22 | Host screen: scrolled cards draw under the status bar and the transparent header with no material behind them ("CPU 13%" behind the clock) |
| 23 | Network page lists and overlays a power event ("ANE 1.4 W · Photos face analysis"); its label is drawn as text over the chart line |
| 24 | Power page is one area chart; the desktop's Power & Sensors page has rings, a stat strip, a ticked chart and a thermal heatmap |
| unchecked | Dynamic Type at accessibility sizes, touch targets, pairing, debug and settings sub-pages |

The user's notes since the audit are recorded as decisions in section 7. Settings sub-pages,
audited the same day:

- Hosts makes every host a card, with a cyan Rename, arrows and a cyan Remove.
- This iPhone shows only "Available after pairing".
- Data has a toggle row with no footer.
- Appearance marks the selection with cyan link text instead of a checkmark.
- About sets label/value rows at body size with no value column.

Three code audits ran the same day (architecture, error handling, tests). They found that the
seams the polish would build on are unsettled:

- the native core is owned by the debug screen;
- the card content is composed twice;
- the live state machine exists twice and has drifted;
- most RFC 3 failure states never reach the UI.

Plan phase 7 fixes those seams (section 6). Every other audit item is placed in section 9.

The user then decided that the phone keeps no history (D-152). The host answers every
history read with a bounded query, and the phone holds the answers in memory only. This
removes the mirror and its sync policy, storage budget and failure states. That change also
lands in plan phase 7 (section 6), and it changes sections 4.0, 4.4, 4.6 and 4.8.

## 2. Goals and non-goals

Goals:

- Every screen reads as StatGlass in light, dark and at AX1. That means the design system's
  tokens, accents, weights and surfaces; RFC 1.4's type mapping; and native iOS navigation and
  list behavior wherever iOS has a convention.
- The host screen reads like the popover at phone scale.
- Module pages show what the dashboard module pages show, minus investigation.
- Every RFC 3 state the phone can reach has a rendering and a test (section 4.0).
- Shared primitives are built once, so the surface work can fan out to parallel lanes.

Non-goals (the user's choice, 2026-11-25): the phone is a basic monitor, not an investigation
tool. So it has no brush or range selection and no attribution, no selection veils or chips, no
per-app usage tables over a range, no row expansion or drill-down, and nothing that explains
what caused a value. The restricted allowlist stays closed to `UsageByApp`, `HistoricalUsage`,
`UsageProcesses` and `Space*`; the user chose the live process table over reopening it. Also
out: an iPad layout, new metrics, background refresh, and any wire change beyond
`NetworkAddresses` and `History` (section 6).

## 3. Design direction

The popover is the reference for the host screen. The dashboard module pages are the
reference for module pages. `design-system.md` governs both.

**Type.** RFC 1.4 maps popover roles to iOS text styles. The roles scale with Dynamic Type,
weight 590 renders as `"600"`, and "rounded" means `ui-rounded` with tabular numbers. The prop
is `variant`, renamed from `role`, which shadows React Native's ARIA `role` (architecture M1).

| Variant | iOS style | Size / weight | Use |
| ------- | --------- | ------------- | --- |
| `largeTitle` | Large Title | 34 / 600 | native titles |
| `title` | Title 2 | 22 / 600 | sheet and section titles |
| `onboardingTitle` | Title 1 | 28 / 600 | welcome, pairing |
| `cardTitle` | Footnote | 13 / 600 | card and section titles |
| `cardFigure` | Subheadline | 15 / 600 rounded tabular | card headline value |
| `heroFigure` | Title 1 | 28 / 600 rounded tabular | module lead figure, pairing code |
| `body` | Body | 17 / 400 | prose |
| `label` | Footnote | 13 / 400 muted | row and stat labels |
| `value` | Footnote | 13 / 400 tabular | row and stat values |
| `caption` | Caption 1 | 12 / 400 muted | secondary lines |
| `axis` | Caption 2 | 11 / 400 muted tabular, max scale 1.5 | ticks, ceilings |

**Color, shape and motion.**

- Colors come from the theme tokens in `theme.generated.ts`, through `useThemeColors()`
  (plan 7a). Module accents use ramp steps 100/60/35/20 %.
- Cards use the popover surface, 12 pt padding, 8 pt gaps, and the swatch-title-value header.
- Destructive actions use `--color-destructive`, never cyan. Cyan is for primary actions and
  links.
- A stale stream dims to 50 % over 150 ms, and the segmented thumb slides over 150 ms. Both are
  0 ms under Reduce Motion or Low Power Mode (`ui/motion.tsx`).
- Charts follow the design-system Y-scale rule: a fixed domain for bounded metrics, a labelled
  nice ceiling for autoscaled ones. Gaps are hatched, never interpolated.

**Avoid generic layouts.** That means no centered hero, stat-tile grids, eyebrow labels or
decorative badges. Each screen is checked against the ce:design `references/slop.md` and the
repo's `frontend-design-slop` skill.

## 4. Surfaces

### 4.0 Connection problems (plan phase 7 lane f)

`phoneProblem(record, nowMs): PhoneProblem | null` (`packages/core/src/phone-connection.ts`)
is the only place phone failure wording lives. It returns `null` while the host is connected,
and it reads typed fields only, never the `error` text.

```ts
export type PhoneProblemKind =
  | "key_not_accepted" | "no_longer_authorized" | "host_key_changed" | "identity_changed"
  | "update_host" | "update_app" | "incompatible" | "app_not_running" | "monitoring_off"
  | "agent_not_running" | "tailscale_down" | "local_network" | "name_not_resolved" | "timeout"
  | "refused" | "unreachable" | "local_offline" | "offline" | "phone_key_unavailable"
  | "internal";
export type PhoneAction = "retry" | "re_pair" | "open_settings" | "open_tailscale";
export interface PhoneProblem { kind: PhoneProblemKind; title: string; short: string;
  recovery: string; action: PhoneAction | null; tone: Tone }
```

`hostStatusSummary` (7f) drives the row status, the pill and the module page from one clock
conversion. The hosts list shows `short` beside "Needs attention", and the host page shows a
banner with `title`, `recovery` and the action. The polish phases restyle these and keep the
wording.

**RFC 3 coverage.** Each state, the lane that renders it, and the test that proves it. "7f
row" means a case in `packages/core/src/phone-connection.test.ts` plus the `phone-errors`
scenario host checked in `apps/mobile/test/connection/`.

| RFC 3 state | Rendering | Lane | Test |
| ----------- | --------- | ---- | ---- |
| 3.1 Wi-Fi to cellular | No problem; a short live hole, then recentering | 7c | `live-session.test.ts` reconnect case |
| 3.1 Tailscale off on the phone | `tailscale_down`, Open Tailscale | 7f | 7f row; `host-screen.test` banner action |
| 3.1 Tailnet ACL, captive portal | `timeout`, mentioning tailnet access rules | 7f | 7f row |
| 3.1 Local Network denied | `local_network`, Open Settings | 7e builds the native case, 7f words it | `native-error.test.ts`; 7f row. Unverified on device: the simulator doesn't enforce Local Network privacy |
| 3.1 Name not resolved, refused, unreachable | `name_not_resolved`, `refused`, `unreachable` | 7f | 7f rows |
| 3.1 Low Data Mode, or cellular with "Live updates on cellular" off | Full demand runs as Compact; the pill says "Every 5 s on cellular". History still loads when asked | 7k (switch), 8d (policy), 11c (pill wording) | 7k bridge test; `tests/demand.rs`; 11c pill test |
| 3.1 MagicDNS off, NAT64 | No UI; the route race and `getaddrinfo` handle them | phase 4 | existing dialer tests |
| 3.2 Mac asleep | `offline`: dashes, no chart, "Offline since HH:MM" in host time. No history (D-152) | 7f, 7k | `hosts-list.test` exact strings, non-zero clock offset; 7k offline host makes no history call |
| 3.2 StatGlass not running, monitoring off | `app_not_running`, `monitoring_off`, Retry | 7f | 7f rows |
| 3.2 Agent stopped or updating | `agent_not_running`, "Retrying at HH:MM" | 7f | 7f row |
| 3.2 Identity changed | `identity_changed`, Re-pair | 7f | 7f row |
| 3.2 Phone key removed | `no_longer_authorized`, Re-pair | 7f | 7f row |
| 3.2 Host key changed | `host_key_changed`, Re-pair | 7f | 7f row |
| 3.2 Key refused at first connect | `key_not_accepted`, Re-pair | 7d types it, 7f words it | 7l `facade_tests.rs` refused key; 7f row |
| 3.2 Host reinstalled, wide host | No UI: history answers come from the new database; live is projected | existing | existing |
| 3.3 Host too old for history | Chart: "Update StatGlass on <host> to see history"; live keeps ticking | 7i (`RemoteUnsupported`), 7k | 7i feature test; 7k test |
| Host busy with history queries | Loading, retried after 1 s up to 3 times; after the third `Busy`, the chart's load error with Retry | 7j2 (`Busy`), 7k | 7j2 concurrency test; 7k test walking all four answers |
| 3.3 Host or app too old | `update_host` / `update_app` from `incompatible_side` | 7d, 7f | `connect/tests.rs` side cases; 7f rows |
| 3.3 Restricted command refused | `incompatible` | 7d (agent marker), 7f | `connect/tests.rs`; 7f row |
| 3.4 Backgrounded, foregrounded | Sessions quiesce with nothing to commit; the open host dials first | phase 6, 7i, 8d | 7i quiesce test; `tests/demand.rs` |
| 3.4 20+ hosts | Only visible rows hold sessions | 8d | `tests/demand.rs` |
| 3.4 Phone offline | `local_offline`, one "This iPhone is offline" line | 7f | 7f row; `hosts-list.test` |
| 3.4 Restored to a new phone | Pair-again state; hosts show "Needs pairing" | 8c logic, 11b view | 8c `pairing` tests; 11b welcome test |
| 3.4 Keychain locked or key missing | `phone_key_unavailable` | 7e | `native-error.test.ts`; 7f row |
| Host start fails (endpoint, signer) | The kind from `open_error` | 7i, 7f | 7i registry test; 7f row |
| Source task panic | `internal` | 7d, 7f | `source/status.rs` test; 7f row |
| 3.6 Time | One host-clock conversion on every screen | 7f | `hostStatusSummary` clock-offset test |
| 3.8 Diagnostics | Rust logs to os_log, subsystem `app.statglass` | 7l | `logging.rs` test; one simulator log line |

The states with no row here are placed in section 9: a corporate VPN, a changed LAN address
(Bonjour), Low Power and thermal policy, and the Diagnostics export. D-152 makes several RFC 3
rows moot: there is no mirror to corrupt, prune, back up or commit on kill, and no `not_synced`
span, because the phone stores nothing.

### 4.1 Navigation chrome and theme (items 1-4, 17, 21, 22)

The navigator `ThemeProvider` and `useThemeColors()` land in plan 7a, which deletes the
per-screen tint code. This section is what the chrome looks like on top of them.

**Titles.**

- The hosts list keeps the large title "Hosts".
- The host screen's large title is the host name. It collapses on scroll, and there is no
  in-content title.
- Module pages use a standard title.

**Back (the user's decision, 2026-11-25).** Host, module and settings sub-pages use a minimal
back control: a chevron only, with no label and no glass fill, tinted `foreground`, in line
with the title, in a 44 pt hit area. It carries `accessibilityLabel="Back"`, and the screen sets
`accessibilityEscape` (`onAccessibilityEscape`). The native edge swipe-back stays. The host
pager also stays, so a mid-screen horizontal swipe means "next or previous host", never back.
That is why the chevron stays visible. Settings loses its hand-drawn back (architecture I6):
the settings stack is presented so the native back applies.

**Header buttons.** `HeaderButton` is a 28 pt stroke icon in a 44 pt hit area, tinted
`foreground`, with no glass fill (settings, close, more). Icons come from one `ui/icons.tsx`
on `expo-symbols`, which replaces three chevron paths and an inline gear (architecture M3).

**Scroll edge (item 22).** No content may draw under the status bar without a material behind
it. Every scrolling screen uses the chrome lane's `ScreenScroll`, a ScrollView with
`contentInsetAdjustmentBehavior="automatic"`, so content starts below the header. Every header
is configured through `screenOptions(colors)`:

- `headerTransparent` with `headerBlurEffect: "systemChromeMaterial"` (light and dark), so
  iOS shows its scroll-edge material once content scrolls under the bar.
- `headerLargeTitleShadowVisible: false` at rest.

A screen that hides its header clips content at the top safe-area inset instead.

**Demo badge.** The demo badge is a "Demo" chip button. It opens an action sheet with "Exit
demo", which returns to the welcome screen.

### 4.2 Welcome and first run (item 20; the user's front-door note)

**Layout, top to bottom:**

1. A live preview: the real `CpuCard`, `MemoryCard` and `NetworkCard` on the demo transport's
   live fixture at 1 Hz, labelled "Example host", with one VoiceOver label. It shows a still
   frame under Reduce Motion or Low Power Mode, and ticks only while the welcome screen is
   focused.
2. One sentence on what the app does.
3. "Add a host" (primary).
4. "Try demo hosts" (secondary).

The title uses `onboardingTitle`. The screen fits an iPhone SE at the default size and scrolls
at AX1. The demo lifetime is owned by a demo provider, not by route names (architecture M8).

**States:**

| State | What shows |
| ----- | ---------- |
| First launch | The welcome screen |
| Demo exited (badge > Exit demo) | Back to the welcome screen |
| Last host removed | Back to the welcome screen. The hosts list replaces to `/` when the native list becomes empty |
| Restored phone (`PairingState.key_changed`, plan 8c) | "This iPhone needs to pair again. Your hosts are still listed, and their history is on the hosts, but this phone has a new key after the restore." Action: "Pair again", which opens the pairing screen. Hosts stay listed with "Needs pairing" |

**Setup guidance lives on the pairing screen, before scanning.** The user needs it at the
moment they have to go and get a code. It is also reachable from Re-pair and from Settings,
where the welcome screen is not. Keeping it off the welcome screen keeps the front door to
one sentence and two actions.

The steps:

1. On a Mac, open StatGlass and choose Pair iPhone. On Linux or any other host, run
   `sudo statglass-agent pair`.
2. Scan the code or paste it.
3. Approve on the host.
4. Done.

Below the steps:

- **"Host doesn't have StatGlass yet?"** For a Mac, the latest release URL
  (`https://github.com/steamfield/statglass/releases/latest`, copyable). For Linux, the agent
  is installed from the Mac app (README "Monitor a Linux host"). See question 1.
- **What the phone can see:** "This iPhone gets a read-only, restricted key. It can see
  metrics and history, can't run commands, and you can revoke it from the host at any time."

### 4.3 Pairing presentation (plan 8c owns the logic)

Plan 8c owns `pairing/flow.ts`. Plan 9c owns `after-pair.ts` and the hand-over screens. This
RFC owns the views in `pairing/screens/` and `pairing/help/`. Each step uses one layout: a
title, an explanation, the content, and actions pinned above the home indicator.

The steps:

- camera priming before the system prompt;
- camera denied (Open Settings, plus Paste);
- camera unavailable in the simulator (Paste);
- paste (`SGP1:` text);
- a preview card: host name, OS glyph, routes, code, and "Can also add the hosts it monitors"
  when `can_hand_over` is set;
- waiting ("Waiting for approval on <host>", code in `heroFigure`, Cancel);
- success;
- failure, with the `PhoneProblem` tone and wording (section 4.0).

### 4.4 Hosts list (items 13-16)

**Row.** The top line shows the name, OS glyph and status. Below it are three equal columns,
each a `cardFigure` value in the accent's ink over a 36 pt chart:

- CPU sparkline (cyan);
- memory sparkline (violet, % of `mem_total_bytes`);
- network mirrored up/down sparkbars (green, the popover network style, down at ramp step 1,
  up at step 2).

**Scale.** CPU and memory autoscale. The ceiling is `niceCeiling` of the 30-minute maximum,
with a floor of 10 % for CPU and 25 % for memory, labelled top-left in `axis`. Network
autoscales each direction. Why not a fixed 0-100 domain: at 36 pt, a 5-25 % CPU range would be
drawn in 7 pt. The labelled ceiling keeps the scale honest, as the popover's CPU chart does.

**Gaps, stale and offline.** A null bucket is a gap, never zero. A stale row (connected, frames
late) dims to 50 %. An offline row shows dashes, no chart, and "Offline since HH:MM" in host
time. Why not the last values, dimmed: the phone has no history behind them (D-152), and the
errors audit (H4) found that stale values read as live. A time with dashes can't be mistaken.

**Data.** Each visible row makes one `hostHistory` query for `cpu.total`, `mem.used`,
`net.rx_total` and `net.tx_total` (the host totals; `net.rx`/`net.tx` are per interface) over
30 minutes, with the budget from its column width. That replaces
`RecentRequest`, which can't be scoped and returns every series. Each 5 s `HostSummary` is then
appended (section 4.8). Rows update every 5 s, which the user confirmed is fine, and the pill
still says Live. A host too old for the history query draws its sparkline from summaries as
they arrive.

**Demo and empty.** Demo hosts get distinct vitals and history seeded from their ids. Only the
`sleep-gap` scenario shows a gap, and live frames join the seeded history with no hole. A
native list with no hosts replaces to the welcome screen.

### 4.5 Host screen and cards (items 1, 5-12, 22)

**Card anatomy.** Cards follow the popover: an 8 pt accent swatch, then the title, the value,
and the density chevron on the right. Card text comes from the shared card models (plan 7g),
so the phone and the popover say the same words. The density chevron is the only control in
the header; it no longer competes with a module chevron.

- **Fit:** CPU, Memory, GPU and Network fit one iPhone 18 Pro screen at the default size.
  Smaller phones scroll.
- **CPU:** the ceiling label sits on the top gridline, over a 52 pt chart.
- **Memory:** "Pressure · normal|warn|critical", and a one-column legend with every swatch
  (Swap hatched).
- **Power:** unreported components are omitted. With none, a compact unavailable row shows.
  "Power & battery" shows the battery inline.
- **Unavailable modules:** one compact line (title, reason), in unchanged `popoverSlots` order.
  Item 11 keeps the shared rule and shrinks the rendering.
- **Network:** the popover's mirrored bars (upload above, download below) at ramp steps 1
  and 2, with "↓ Download" and "↑ Upload" labels.
- **Charts:** accessible names and ceilings come from the shared chart models, not phone
  copies (architecture I4).

**Interaction model.** iPhones have no pressure sensing; Haptic Touch is a long press, so a
"hard press" cannot be told apart from a long press. The gestures are:

| Gesture | Result |
| ------- | ------ |
| Tap the header chevron (44 pt hit area) | Toggle compact or expanded, as the popover's chevron does, with a light haptic. Density persists per card in phone settings (`compact[card]`) |
| Tap the card body | Open the module page |
| Long press, then move | The card lifts with a medium haptic, the drag reorders the stack, and a light haptic fires on drop. This is the same `ReorderList` primitive as Settings > Hosts |
| Long press, released without moving | An action menu: Compact or Expand, Open <module>, Move to top |
| VoiceOver | Custom actions: Toggle compact, Move up, Move down, Open |

The order persists as `cardOrder` in phone settings: one order for all hosts, as today and as
in the popover. The long-press-and-release menu replaces the current card options sheet and
its "Move up/down".

**Menu choice: the drag primitive plus `ActionSheetIOS` on release, not a native context
menu.** The press-and-hold-to-menu, hold-and-move-to-drag behavior is the iOS Home Screen
model. A native `UIContextMenuInteraction` (zeego, `react-native-ios-context-menu`) takes over
the long press itself. Neither library documents handing a lifted preview to a Gesture
Handler or Reanimated drag, so a single press could not become both a menu and a reorder.
`ActionSheetIOS` ships with React Native, is native, and needs no dependency. The phase 10
scaffold checks zeego's current documentation once. If zeego does support a lift-then-drag
handoff, the scaffold switches to it and says so.

**Rendering cost.** `CardStack` builds card props per card, behind selectors, so a 1 Hz tick
re-renders only the cards whose slice changed (architecture I5). Card dimming moves from
React Native `Animated` to Reanimated (architecture M14). A `Profiler` render-count test
replaces the export spies (tests M2).

### 4.6 Module pages (items 18, 18b, 19, 23, 24)

**Frame, top to bottom:**

1. The native title, with a hardware subtitle.
2. The range control: a segmented control with 5m, 1h and More. More opens a sheet of the
   `RANGE_PRESETS` the host keeps.
3. A stat strip: a `heroFigure` lead, labelled items, and Avg and Peak for the range, taken
   from the history answer's `stats`. A missing value shows `MISSING`, never 0.
4. Charts with labelled value and time ticks, ramp series and hatched gaps.
5. Touch scrubbing. A pan shows a crosshair and a readout of the host-clock time and each
   series. A long press pins the readout with a haptic. VoiceOver gets an adjustable element.
6. The live process table: read-only, at most 10 rows, interest on focus and off on blur.
7. The events list.

Every chart's history comes from one `hostHistory` query (section 6, F-history), held for
30 s after the page leaves. The CPU heatmap is the exception: its per-core series are a query
of their own, budgeted by its column count, which the host clamps at 256 series rather than 32,
so a host with more than 32 cores draws every core. A range change asks the host again. A failed status read shows the
module's error state, not a blank page (errors L3).

**Events and annotations (item 23).**

- Each page shows only its own module's events. The host filters them at the source: the
  history query names its module, and `EventDetail::module()` (plan 7j1) maps the kinds:
  - `power_spike`, `fans_ramped` and `thermal_state` go to Power & Sensors;
  - `sustained_process` goes to CPU;
  - `alert` goes to the module of the rule's metric.
  Rust owns the mapping, because every consumer must agree on it (`data-boundary.md`).
- The list and the chart annotations use the same filtered list.
- Annotations are pills at the top of the plot area, following the design system's
  Annotations rule. When two collide, the later one moves to a second row, or they merge into
  a "+N" pill. Labels are never drawn over a series.
- The layout is a pure function in core `widget-models/chart-annotation.ts`, tested once.
  `widgets/chart-annotations.tsx` renders it.

**Live process table.**

- It uses the desktop's `ProcessInterest` and `groupLiveProcesses` through the restricted
  session's process interest. There is no new logic on the phone.
- Interest is set only while the table is on screen, through `useProcessDemand` (plan 8d).
- Each page sorts by its own metric:

  | Page | Sort |
  | ---- | ---- |
  | CPU | CPU % |
  | GPU | GPU (`gpu: true`) |
  | Memory | memory |
  | Network | rate (`network: true`) |
  | Power & Sensors, Battery | energy |

- A host that sends no processes shows "Processes are not available from this host".

**Sections per page.** Each section is ported or omitted:

| Page | Port | Omit (reason) |
| ---- | ---- | ------------- |
| CPU | Header "chip · N performance + M efficiency cores"; stat strip with a Total lead, User, System, I/O wait and Steal where present, Idle, Load avg, Pressure stall, Avg and Peak; the total chart (user and system ramp); a per-core heatmap with P and E rows; processes | `UsageAppsCard` and the "Every process" link (per-app over a range: the user's non-goal, and refused by the session) |
| GPU | Header chip; utilization chart with Utilization, Renderer, Tiler, Frequency, Power, Avg and Peak; a frequency ring and a residency stack bar; the power chart; processes | GPU `UsageAppsCard` (same reason) |
| Memory | Header "N GB unified", or MemTotal on Linux; a composition stack bar with Used, Pressure or Pressure stall, Swap, Compressed, Peak used and Peak swap; a pressure chart (Mac) or Used/Cached chart (Linux); a swap card with Used, In, Out and a chart; processes | Memory `UsageAppsCard` (same reason) |
| Network | Header from `NetworkAddresses` (below); a stat strip with a Download lead, Upload, Of link, and downloaded and uploaded totals; the desktop's mirrored history bar chart (upload above, download below, a labelled ceiling per direction, time ticks), replacing today's two overlapping area lines; the interfaces list; processes by rate | `AppsCard`, `AppsNowCard` and `SelectionSummary` (attribution and selection: the user's non-goal) |
| Power & Sensors | Header subtitle (power source, system draw); four rings from the shared `RingGauge` model: CPU temperature with the P-cluster, GPU temperature with frequency, Fans RPM with left/right and mode, System W with source and package; a stat strip with System W, CPU, GPU, ANE, DRAM, Avg and Peak; a ticked power chart with a legend and its notes ("CPU power: P cores"); the SoC thermal zones heatmap from the shared `HeatMatrix` model (temperature ramp, legend, current value per zone, °C or °F from the iOS locale's measurement system: the phone adds no setting, and the model formats in whichever unit it is passed); the battery day card when present; processes by energy | "Drag across the chart to see what used it" and the app lines on the power chart (attribution: the user's non-goal) |
| Battery | Header charge state; rings for Charge, Health and Cycles, and Power; the battery day chart with Charge, Health, Cycles, Remaining, Full charge and Temperature; processes by energy | none |

The module is named "Power & Sensors" everywhere on the phone (title, card menu, VoiceOver),
as on the desktop. Linux hosts omit the rings and zones they don't report, using the same
rule as the cards.

**Network header (the user's decision, 2026-11-25, reversing this RFC's earlier proposal).**
It reads "en0 · 143 Mb/s link · 192.168.86.242 · Public 76.143.14.53", as on the desktop.

- The data comes from `PhoneTransport.networkAddresses(host)`, the query added in plan 7h
  (section 6, F-wire). It is fetched when the page gains focus. The page refreshes it on focus
  only, because the host caches the public IP (24 hours, or until its network changes).
- While `public_ip` is `pending` (the host's cache is cold), the page polls every 2 s, at most 5
  times, only while it is visible. The host never blocks the answer on the lookup.
- IPv6 addresses go in a second caption line when present.
- `PublicIp.state` selects the text:
  - `pending` shows "Public …";
  - `unavailable` shows "Public unavailable", with the reason in the accessibility hint;
  - `unknown` (a state from a newer host) shows "Public unavailable";
  - a host too old to answer shows the interface and link speed from the live frame, and
    no address line.

### 4.7 Settings

The pages use the grouped-list surface (`ui/grouped-list.tsx`, which replaces 14 copies of the
card markup, architecture M3), `ListRow`, section headers in `cardTitle`, and the minimal back
chevron.

**Hosts.** One grouped list:

- Each row shows the OS glyph, name and status subtitle, and opens the host detail page.
- Swipe-to-delete opens a confirmation: an action sheet whose "Remove <host>" is destructive
  and says this iPhone stops monitoring the host, whose history stays on the host (the phone
  keeps none, D-152).
- Press-hold-and-drag reorders through `ReorderList`, with haptics on pickup and drop and
  VoiceOver "Move up"/"Move down". The order persists in phone settings.

**Host detail** (`settings/host/[host]`):

- Rename (an inline field).
- Routes (read-only).
- Re-pair.
- "Update from Mac", a link to plan 9c's `/update-from-mac`.
- Remove, as a destructive full-width row at the bottom, with the same confirmation.

**The other pages.**

- **This iPhone:** the key line in a monospace caption with Copy, and App Lock.
- **Data:** one switch, "Live updates on cellular", wired by 7k, with a footer: when it is
  off, the host screen updates every 5 s on cellular. "Sync history on cellular" is gone
  (D-152).
- **Appearance:** checkmark rows (System, Light, Dark), with no link-colored text. 8c moves
  applying the setting out of the route.
- **About:** label/value rows, with values right-aligned in `value`, and the licenses link.

### 4.8 Data demand (plan 8d)

Screens never call the demand store. The data hooks declare demand while their screen is
focused:

| Screen | Demand | What flows |
| ------ | ------ | ---------- |
| Hosts list | `compact`, visible rows only | `Interest { detail: false }`, so `HostSummary` arrives every 5 s. There is one 30-minute `hostHistory` for the row's four series (the totals) when it becomes visible, and then each summary is appended to the sparkline. No `Live1s` subscription |
| Host screen | `full`, the pager's current host | `Subscribe Live1s` |
| Module page | `full`, its host | `Live1s`; process interest only while the live table is on screen, cleared on blur |
| Welcome preview | The demo transport only | n/a |
| Settings, pairing, debug | Nothing | n/a |

- `RecentRequest { from_ms, to_ms }` can't be scoped by series, so the row uses the history
  query, which carries only the row's series and a point budget.
- Rows update every 5 s while the pill says Live. That is the summary period, not a stall, and
  the user confirmed it is fine. There is no wire change for it.
- With "Live updates on cellular" off, on an expensive path, `full` runs as `compact`.
- A host with no demand closes its session after `PARK_GRACE` (15 s). The core then holds no
  live ring, stream or history for it.
- Plan 8d measures, against the ssh-docker Linux agent:
  - bytes per second per host at Compact, Full, and Full with process interest;
  - bytes and agent CPU per history query at 1 h, 24 h, 7 d and 30 d;
  - agent CPU during 30 s of range flipping.
  The figures go in the plan's Log. This RFC states no measured figures until then.

## 5. Shared primitives (build first)

| Primitive | Where | Shared or phone-only |
| --------- | ----- | -------------------- |
| Text variants (section 3 table) | `apps/mobile/src/ui/text.tsx` | Phone-only |
| `HeaderButton`, back chevron, `screenOptions`, `ScreenScroll`, icons | `apps/mobile/src/ui/header-button.tsx`, `back-button.tsx`, `screen-options.ts`, `screen-scroll.tsx`, `icons.tsx` | Phone-only (the theme itself is plan 7a) |
| Grouped list, `ListRow` (glyph, title, subtitle, accessory, destructive variant), swipe row | `apps/mobile/src/ui/grouped-list.tsx`, `list-row.tsx`, `swipe-row.tsx` | Phone-only |
| `ReorderList` (press-hold drag, haptics, VoiceOver Move up/down, `onReorder(ids)`, `onReleaseWithoutMove`) | `apps/mobile/src/ui/reorder-list.tsx` | Phone-only |
| Segmented control, bottom sheet | `apps/mobile/src/ui/segmented-control.tsx`, `sheet.tsx` | Phone-only (the desktop has its own) |
| Ticked axis (`valueTicks`, `timeTicks`) | `packages/core/src/chart-math/axis-ticks.ts` | Shared model; the desktop adopts it later |
| Module specs (`CPU_HERO` … `memoryHero`, totals) | `packages/core/src/module-hero.ts`, desktop re-exports | Shared data |
| Stat strip | `apps/mobile/src/module/stat-strip.tsx` over core `series-stats.ts` formatting | Phone renderer, shared formatting |
| Heat matrix, ring gauge | `packages/core/src/widget-models/heat-matrix.ts`, `ring-gauge.ts`; the desktop renders the models; phone twins | Shared widget models (`widget-model` skill) |
| Sparkline variants: a compact `StreamArea` with a corner ceiling; `Sparkbars` (mirrored, sparkline scale) | `apps/mobile/src/widgets/` over the existing `streamAreaModel`/`mirrorBarsModel` | Phone twins of shared models; a model option is a fork listed in `packages/core/README.md` |
| Phone `setProcessInterest` | Already built: `MobileCall::SetProcessInterest` in the plan 7 scaffold, `crates/statglass-mobile/src/sessions/processes.rs` in 8d | Shared Rust (stats now come in the history answer, D-152) |

Card content models (plan 7g) and the navigator theme (plan 7a) were in this table before the
audits. They now land in the foundation.

**Drag list choice: `react-native-reorderable-list`.**

- It is maintained and built on Reanimated and Gesture Handler, which are already
  dependencies.
- It replaces FlatList with `onReorder`, auto-scroll and drag handles.
- It has `NestedReorderableList` for the card stack inside a ScrollView.

Haptics come from `expo-haptics` (installed) in `onDragStart`/`onDragEnd`. Swipe-to-delete
uses Gesture Handler's `ReanimatedSwipeable`.

The scaffold installs the list with `bunx expo install`, confirms its peer ranges cover
Reanimated 4.7 and Gesture Handler 3.3, and renders it under jest and in a simulator build. If
it doesn't fit, the scaffold stops and reports. The fallback is a `ReorderList` written on
Reanimated and Gesture Handler directly, as an L lane of its own.

## 6. Foundation (plan phase 7)

Foundation runs before pairing, because the audits' fixes touch the files pairing builds on,
and every chart builds on D-152's history path. Its thirteen lanes (a to l, with j split into j1 and j2) are disjoint and run
in parallel. Full briefs are in the plan.

| Lane | Lands | Audit items |
| ---- | ----- | ----------- |
| a, core owner and shell | `CoreProvider`/`useNativeCore` (one owner for the native core, replacing the debug screen's `WeakMap`); the navigator `ThemeProvider` and `useThemeColors()`; one `AppProviders` shared by the root layout and `test/render.tsx`; a root `ErrorBoundary`; a host-route guard when no transport exists; one `GestureHandlerRootView`; query keys scoped to the transport; the transport barrel | arch F1, F4, I2, I7, M2, M3 (providers), M5; errors M8, L4 |
| b, boundaries and tooling | Biome rules: the native module only from `src/transport/`, widgets render-only, each with positive and negative fixtures; the write hook; `FakeNative` replaces `jest.mock` of the native module; one `mockAppState()`; a 5 s jest timeout; doc drift | arch I1, M15, M16, M18; tests H1, L5, L7 |
| c, live session | One core `live-session.ts` used by the desktop host store and the phone. It settles the drift: catch-up at 120 s on both (the desktop's figure, measured against its ring), and terminal errors retry with backoff on both (the phone stopped, which froze a recoverable host) | arch F3; errors L1, L5 |
| d, session and IPC errors | The RFC 3.2/3.3 states carried in status (`incompatible_side`, `internal` on a panic, `RemoteRefused`); the phone-only `SyncPolicy` and `MirrorPolicy::phone` removed from `statglass-session` | errors H3 (Rust half), M3, M4, M7, L5, L7, L8 |
| e, native errors | Swift `NativeFailure` mapped to a typed `NativeError`; a fallible `public_key` (`phone_key_unavailable`); a Swift test package; typed `callCore` results | errors M1, M2, L6; arch M11; tests M9 |
| f, connection states | `phoneProblem` and `hostStatusSummary` as the single status wording; every RFC 3 state reaching the hosts list and host page (section 4.0); the `phone-errors` scenario and `failNext` instead of 22 per-test overrides | arch I3; errors H3, M9, L2; tests H2, M3, M5, M6, M10 |
| g, card models | `packages/core/src/popover/cards/` content models shared with the desktop popover; `WidgetAccent` moved | arch F2, M6; tests M1 (popover-cards, card-stack) |
| h, network addresses | The `NetworkAddresses` query below (D-153) | the user's Network decision |
| i, phone core without a mirror | No mirror store, sync policy or storage budget (the scaffold cuts the calls first); `live_allowed` for the cellular switch; host opens that can't fail on a store, and `open_error` for start failures (H2 reshaped); stale vitals cleared on offline (`as_of_ms`); the history client, skipping event kinds it can't decode; the Docker end-to-end facade test | errors H2, H4; tests M8; D-152 |
| j1, host history read path | `Query::History` below: tier choice, clamps, the layout filter, recent rows up to now, events filtered by module, per-key stats | D-152 |
| j2, host history concurrency | The per-session queue by chart key, the host-wide semaphore and cache on `HostServer`, the tick-timing test | D-152 |
| k, phone history data | `useHostHistory` with a width budget and 30 s cache; unsupported and busy states; the one cellular switch, wired; the mock's answers | tests M7 (switch wired, not removed); D-152 |
| l, logging and facade test | A `tracing` subscriber to os_log; a `MobileCore` facade unit test over a scripted dialer | errors H1; tests M8 |

**F-wire: host-served network addresses (lane h).** This is a protocol addition and a one-way
door, so it lands in the foundation, with its D-entry first, rather than in the Network UI
lane. The UI lane only renders it.

- **Message.** `Query::NetworkAddresses` and `Answer::NetworkAddresses(HostAddresses)` in
  `statglass-proto`. The types:
  - `HostAddresses { interface: Option<String>, link_mbps: Option<u32>, ipv4: Vec<Ipv4Addr>, ipv6: Vec<Ipv6Addr>, public_ip: PublicIp, as_of_ms: i64 }`,
    encoded as a CBOR map with optional fields, so later fields stay additive.
  - `PublicIp { Known { ip }, Pending, Unavailable { reason }, Unknown }`, adjacently tagged
    `state`, with `Unknown` decoded through the proto's `Tagged`/`lenient` pattern so a newer
    state doesn't fail the answer.
- **Allowlist.** `SessionScope::Restricted` allows `NetworkAddresses`. Every other `Query`
  stays refused, tested in `crates/statglass-remote/tests/restricted.rs`.
- **Skew tests** (`crates/statglass-proto/tests/addresses_skew.rs`):
  - a new client asking an old host gets `Unsupported`, which maps to "Addresses are not
    available from this host";
  - an old client never sends the query, and a new host decodes old messages unchanged;
  - a `PublicIp` state from a newer host decodes as `Unknown`.
- **Host answer.** The interface is the egress interface, falling back to the primary. The
  answer carries the link speed when known, the IPv4 addresses, and the non-link-local IPv6
  addresses.
- **Public IP follows D-093, widened by D-153.**
  - Every host looks up its own, Linux agents included, with no switch. The user accepted that
    a headless server now makes this request occasionally.
  - It is fetched on demand only (a client asked for the addresses), after the local read
    succeeds, never in the background.
  - It uses `/usr/bin/curl` to `api.ipify.org` with a 5 s timeout.
  - A known answer is cached for 24 hours, and looked up again early only when the primary or
    egress interface or the local address changes, so a laptop that moves networks is right.
  - A failed lookup answers `Unavailable` with the reason and is cached for 10 minutes, with no
    retry loop.
  - A Linux host without `/usr/bin/curl` answers `Unavailable { reason: "curl not installed" }`
    (system tools only, D-058).
  - A cold cache answers `Pending` at once; the client polls (section 4.6).
  - The public IP never rides the 1 Hz frames, only this answer.
- **Sharing.** The Mac app and the agent share one resolver, in `statglass-remote::addresses`.
  Plan 8e moves the desktop onto it: one `get_host_addresses` command answers this Mac from
  the resolver and remote hosts through their session, so the Network page, the Overview
  machine header and the popover Network card show addresses for remote hosts too. A host
  without the feature shows no address row.

**F-history: the host answers history (lanes i, j and k; D-152).** The phone keeps no history.
This is the second protocol addition, and also a one-way door.

- **Why `Query`/`Answer` and not a new message pair.** A history read is a bounded one-shot
  request with one reply, like `HistoricalUsage`. The D-117 query path already gives it
  `Query::Unknown` skew handling, per-variant restricted-scope control, `ErrorCode::Busy`, and
  answering on the blocking pool. Live and durable-sync messages are streams with their own
  state, which this isn't.
- **Request.** `HistoryQuery { series: Vec<SeriesSelector>, from_ms, to_ms: Option<i64>,
  max_points, events_for: Option<Module> }`. `to_ms: None` means "ending now".
  - The phone sets `max_points` from the chart's width: one point per 2.5 pt, clamped to
    30-200. That is about 120-160 on a phone-width chart. A heatmap passes its column count
    (48-60). The phone never asks for more than the chart can draw.
- **Answer.** `HistoryAnswer { tier, bucket_ms, complete_to_ms, series, gaps, events, stats,
  clamped }`.
  - Each series carries only the requested key, with avg, min and max per point and its
    `hold_ms`.
  - `gaps` are explicit, and nothing is interpolated.
  - `events` are the module's events in range, filtered by the host (this fixes item 23 at the
    source). They travel as `WireEvent` rows, so a kind from a newer host passes the codec and
    the phone skips the one it can't decode (D-083).
  - `stats` are avg and peak per requested series key, never pooled per metric:
    `range_stats` pools every series of a metric, so the host narrows the read to each key.
    The phone does no aggregation.
  - `clamped` lists `points`, `series`, `events` or `bytes`, with `Unknown` for a limit from
    a newer host.
- **Host limits.** `HISTORY_MAX_POINTS = 500`, `HISTORY_MAX_SERIES = 32`,
  `HISTORY_MAX_EVENTS = 200`, `HISTORY_MAX_ANSWER_BYTES = 512 KiB`.
  - A request over a limit is clamped, and `clamped` says which limit applied.
  - An answer over the byte limit halves its points until it fits.
  - A per-core request (the CPU heatmap) is clamped at 256 series instead of 32.
  - A request that can't be satisfied at all gets `InvalidArgument`: an inverted range, no
    selectors, or a selector whose metric the catalog doesn't know. A known selector with no
    data in range comes back with gaps, not an error.
- **Bounded work.**
  - **Tier.** The host picks the coarsest persisted tier whose bucket is no wider than
    `(to - from) / max_points`. That gives S10 for about an hour, M1 for about a day and M15
    for multi-day ranges. If that tier no longer retains the range start, the host moves to
    the next coarser tier, never a finer one.
  - **Reads.** The host reads through that tier's unique `(host_id, bucket_ts, layout_id)`
    index (`tier_10s_key`, `tier_1m_key`, `tier_15m_key`), with a `layout_id IN (...)` filter
    (the reader has none today), so it reads and decodes only the layouts that hold the
    requested series: a row is one blob per layout, so series in the same layout are read
    together.
  - **Merge.** Buckets are merged into at most `max_points` slots in one pass, with avg, min
    and max. This is the store's existing `max_points` merge, the code behind
    `statglass_ipc::query_history`.
  - **Up to now.** The writer commits every 5 minutes, so persisted rows alone would leave a
    hole of up to 5 minutes before now. The host passes the hub's recent bucket rows as
    `recent` to `HistoryStore::history_through_now`, bounded the way `HostServer::recent`
    bounds them (`host_server.rs:121-127`), to at most `RECENT_ROWS_MS`. It never passes the
    raw live ring. `complete_to_ms` comes from that snapshot, and the phone joins its live
    window after it.
  - **Row bounds.** Rows read per layout are at most 8,640 at S10 (one day), 10,080 at M1
    (seven days), and for a 30-day M15 read about 2,200 M15 rows plus the 10,080 M1 rows of
    the last seven days, because an M15 read also takes the minutes still in `tier_1m`
    (`db.rs` `bucket_sources`). These are computed from the tier rule and retention, not
    measured.
- **Host CPU.**
  - Queries run in `answering.rs`'s `spawn_blocking`, beside the other D-117 answers, using
    the store's reader checkout. There is no second pool, and the sampler thread is never
    used.
  - One history query runs per session; the rest queue. A newer one replaces a queued one
    only when it has the same chart key (selector set and budget), so fast range flipping on
    one chart doesn't stack work and a page's other charts keep their place.
  - `HISTORY_MAX_CONCURRENT = 2` run host-wide, and beyond that the answer is `Busy`, which
    the phone shows as loading and retries after 1 s, at most 3 times, before showing the
    chart's load error with Retry. The semaphore and cache live on `HostServer`.
  - Identical requests within `HISTORY_CACHE_TTL = 10 s` (range rounded to the bucket width)
    are served from a 16-entry cache. Lane j may drop the cache if it measures a 30-day query
    under 5 ms of CPU, recording why.
  - A tick-timing test runs 30-day queries during engine ticks.
- **Size.** A 30-day answer of 20 series at 200 points is bounded by test at 160,000 encoded
  bytes. A point encodes to about 27 to 36 bytes, so 4,000 points take about 110 to 145 KB.
  The bound is on bytes on the wire after downsampling, not on rows read (those are bounded
  above). It is a test limit, not a measurement. The answer's size depends on the budget, not
  the range length, so 7 d and 30 d cost the same on the wire. Plan 8d records the measured
  bytes for 1 h, 24 h, 7 d and 30 d.
- **Compatibility.** The Hello feature is `query.history.v1`. The client never sends the
  query to a host without it, and shows "Update StatGlass on <host> to see history" while live
  data keeps flowing. Codec round-trip and skew tests run both ways. The restricted session
  allows the query. The mock transport answers it in the same change.
- **On the phone.**
  - React Query holds each answer with `staleTime` and `gcTime` of 30 s, so a back-and-forth
    tap doesn't refetch. The live ring's 60 s backfill covers anything newer.
  - Unmounting releases the answer after 30 s, which a test asserts.
  - Live windows stay the bounded 60 s ring per visible chart, released on unmount.
  - After `PARK_GRACE`, the core holds nothing for the host (8d test).
- **Desktop.** It keeps its mirror for remote hosts in this run, since its alerts, timeline
  and offline history read the local store. A later "view without mirroring" mode for desktop
  remote hosts should use this query rather than a second path.

## 7. Decisions already made (the user's)

- **No history on the phone (2026-11-25, D-152).** The monitored host is the source of truth.
  History comes from a host-served query and lives in memory only, dropped when the view
  unmounts. This reverses `plan/rfc-ios-app.md`'s mirror design (4.4, D-146) at the user's
  request. A 5 s hosts-list update is fine (10 s would be too), so `HostSummary` stays at 5 s.
- **Basic monitor (2026-11-25).** The phone gets visualization parity with the dashboard module
  pages, and no brush, attribution, selection veils or chips, per-app range tables, row
  expansion or drill-down.
- **Live process table.** A live, read-only process table on every module page, sorted by the
  page's metric. The per-app range table stays out, chosen over reopening the restricted
  allowlist.
- **Network parity.** The header shows interface, link speed, local IPv4/IPv6 and the public
  IP, served by the host (`NetworkAddresses`; this reverses the earlier proposal). The stat
  strip shows download, upload, Of link and range totals. Mirrored up/down bars with labelled
  ceilings and time ticks appear on the module page and the host-screen card.
- **Back navigation.** A minimal chevron-only back on the host, module and settings sub-pages;
  edge swipe-back stays; the horizontal host pager stays.
- **Power & Sensors parity.** All servable sections port. Out: the "drag to see what used it"
  affordance, and the app power lines.
- **Hosts-list rows.** Three accent charts tall enough to show normal variation, gaps shown as
  gaps, dimmed when offline, and demo data that varies per host.
- **Settings > Hosts in iOS list conventions.** A row opens a detail page. Remove is
  destructive, never cyan, with swipe-delete and a confirmation. Drag reorder with haptics
  works there and on the card stack, with VoiceOver Move up and Move down.
- **Card gestures.** The chevron toggles density, a body tap opens the module, long-press-move
  drags, and long-press-release opens the menu. There is no pressure-based "hard press".
- **The welcome screen is the front door.** It has a live labelled example preview, "Add a
  host" as the primary action and "Try demo hosts" as the secondary, setup guidance, and the
  first-run, demo-exit, restore and no-hosts states.
- **Public IP on every host (2026-11-25, D-153).** Each host looks up its own public IP on
  demand, Linux agents included, with no switch; 24-hour cache, early re-lookup on a network
  change, 10-minute failure cache. The Mac shows local and public addresses for the remote
  hosts it monitors too (plan 8e).
- **One flow, scoped demand.** One OS-neutral "Add a host" flow, with hand-over as a
  capability. Data demand is screen-scoped, with no background modes (plan phase 8).

## 8. Open questions

1. **Linux install path for a person without a Mac.** The README installs the Linux agent
   from the Mac app only, so "Host doesn't have StatGlass yet?" has no Mac-less answer.
   Options:
   - link the README section and say a Mac is needed;
   - publish a standalone agent install command (a separate piece of work).

## 9. Audit items: placement

Foundation items are in section 6 (tests M7, the dead `liveOnCellular` switch, is wired by 7k).
Phase 8 takes errors M5 and M6 (8b); tests M11 (8b) and L8 (8d); arch M7 (8c, Appearance out
of the route),
M13 (8d, iOS 27 scene lifecycle) and I8's `NSLocalNetworkUsageDescription` (the phase 8
scaffold adds it to `apps/mobile/app.config.ts`; LAN pairing needs it on any device).

The polish phases take the items in the files they own:

| Item | Lane | What |
| ---- | ---- | ---- |
| arch M1 | 10 scaffold | `role` renamed to `variant` on `Text` |
| arch M3 (markup, icons) | 10a | grouped list, `ui/icons.tsx` |
| tests L3 | 10e | drop `className` assertions in the bars test |
| arch I6; tests L1 (about, settings, seam), L4 (settings) | 11a | settings presentation; duplicate and split settings tests |
| arch I9, M8; tests M4 | 11b | debug and phase-1 code out of the layout; demo lifetime; timer outcomes, not internals |
| arch I4, I5, M14; tests M2, L2, L4 (host screen), L10 | 11c | chart wording from shared models; per-card selectors; Reanimated; `Profiler` counts; drop the `Animated` spy; split the long test; assert expected logs |
| tests M1 (hosts list) | 11d | accessible values instead of export spies |
| errors L3; tests L6 | 11e | module status error state; drop the dead latency option |

**Deferred or rejected, with reasons:**

- **arch M4, route shape** (thin routes vs. screens): cosmetic. Pick it up when a route is next
  rewritten. 11a rewrites the settings routes and follows "route reads params, renders the
  screen" there.
- **arch M9, live-store `WeakMap`:** rejected. After 7a scopes the stores to the transport, a
  module `WeakMap` keyed by the transport has the lifetime a provider would give it.
- **arch M10, `toRemoteHostRecord` fabricates desktop-only fields:** deferred. Removing them
  means splitting `RemoteHostRecord` per platform. Revisit only if a fabricated field shows
  up in phone UI.
- **arch M12, Swift `AsyncFunction`:** deferred. The hand-rolled `Task` works, and the Expo
  Modules async API change is not worth churn while 7e rewrites the error mapping.
- **arch M17, split the `MobileCall` dispatch:** deferred. `MobileCall` grows in the phase 7
  and phase 8 scaffolds and in 9c, so splitting it now would conflict with them. Do it once those land.
- **arch I8, privacy manifest, icon, splash:** out of scope. These are App Store work (iPhone
  RFC phases 5 and 6).
- **tests L9, Rust fake of `SessionControl`:** rejected. The sources inside it are real, and
  the audit itself says no fix is needed.
- **RFC 3.1, corporate VPN:** deferred. iOS gives no reliable signal for "another VPN is
  active" to a non-VPN app, so it would be a guess. It surfaces as `timeout` or `unreachable`.
- **RFC 3.1, LAN address changed (Bonjour):** out of scope. Phone discovery is not in 1.0, and
  the Tailscale route covers it.
- **RFC 3.4, phone storage low; RFC 3.5, `not_synced` spans:** moot under D-152. The phone
  stores no history, so there is nothing to fill or leave unsynced.
- **RFC 3.4, Low Power and thermal policy:** rejected for now. Demand is screen-scoped and
  nothing syncs, so this policy would only degrade the screen the user is looking at. Motion
  already stops under Low Power (`ui/motion.tsx`).
- **RFC 3.8, Diagnostics export:** deferred. os_log lands in 7l. A redacted on-device file and
  its export need their own lane.

## 10. Phases

The plan's phase order:

1. 7, foundation: lanes a to l (j split into j1 and j2), in parallel, in any merge order.
2. 8, pairing: lanes a to e, in parallel (e is the desktop's addresses for remote hosts).
3. 9, handover: lanes a to c.
4. 10 to 12, polish, below.

Phase 9 runs beside phase 10, so no phase 10 lane owns phase 9's files:
`update-from-mac.tsx`, `pair-hosts.tsx`, `pairing/after-pair.ts`, `apps/mobile/src/handover/`,
`transport/handover.ts`, and its Rust and desktop files. Phase 11 depends on phase 9 as well
as phase 10: its navigation lane gives `update-from-mac.tsx` and `pair-hosts.tsx` the shared
screen options and back chevron once phase 9 has merged. The phase 10 scaffold adds no `MobileCall` variant
(process interest landed in plan phases 7 and 8), so it doesn't contend with phase 9's
scaffold for `mobile.rs`. Lanes are disjoint by file within a phase, so each lane is an independent
Codex run.

**Phase 10: primitives** (depends on plan phase 8).

The scaffold:

- the text variants and the `role` to `variant` rename;
- `bunx expo install expo-localization` (the Power & Sensors page reads the locale's
  temperature unit; installed here so no lane touches the lockfile);
- the drag-list install check and the zeego check (section 4.5);
- moving `host-settings.tsx` from `hosts/` to `settings/`;
- stub signatures for every primitive in section 5.

The lanes all run in parallel:

| Lane | Size | Owns |
| ---- | ---- | ---- |
| a, chrome | L | `HeaderButton`, back chevron, `screenOptions` with the scroll-edge material, `ScreenScroll`, icons, grouped list, `ListRow`, swipe row, demo badge |
| b, interaction | M | `ReorderList` (with release-without-move), segmented control, sheet |
| c, axis and specs | M | `axis-ticks.ts`; `module-hero.ts` moved to core |
| d, heat and ring models | L | core models, desktop renderers, phone twins |
| e, sparklines | S | the compact `StreamArea` variant, `Sparkbars`, the bars-test cleanup |

**Phase 11: surfaces** (depends on phases 9 and 10). The lanes run in parallel:

| Lane | Size | Owns |
| ---- | ---- | ---- |
| a, navigation and settings | L | the layouts' screen options (including phase 9's `update-from-mac.tsx` and `pair-hosts.tsx`, header options only), every settings page, host detail, hosts reorder and swipe-delete |
| b, front door | L | `app/index.tsx`, `welcome/`, `pairing/screens/`, `pairing/help/`, restore and empty states, the demo provider |
| c, host screen and cards | L | `cards/`, `host/` (card gestures, menu, `ScreenScroll` adoption, Reanimated dimming), `connection/` restyle |
| d, hosts list and demo data | M | `hosts/` minus the settings files the phase 10 scaffold moved, core `mock/remote*.ts`, and the three-series row data in `apps/mobile/src/data/hosts.ts` (keeping plan 8d's demand calls) |
| e, module frame | L | `module/` frame, stat strip, `ModuleChart` and scrub, `LiveProcessTable`, `events-list.tsx`, the annotation layout model and `widgets/chart-annotations.tsx`, `data/history.ts`, `pages/index.ts` with the generic page per module |

**Phase 12: module content** (depends on phase 11). The lanes run in parallel, each owning its
page directories and tests:

| Lane | Size | Owns |
| ---- | ---- | ---- |
| a | L | CPU and GPU, plus `cpu-clusters.ts` moved to core |
| b | L | Memory and Network: the mirrored history chart, and the addresses header over plan 7h's query with the `pending` poll |
| c | L | Power & Sensors and Battery: rings, stat strip, the ticked chart with notes, the thermal zones heatmap, the temperature unit from the iOS locale |

Hand-off: the data hooks that phase 11 lanes d and e edit keep plan 8d's demand calls. Lane a of phase 12 owns the CPU heatmap's separate per-core query.

## 11. Verification

Every surface is checked in the simulator in light, dark and AX1, following
`.claude/skills/ios-simulator/SKILL.md`. Each is compared side by side with its desktop
reference, naming every difference left in place. The references are the popover (`bun run
dev:fast`, `/?window=popover`), `/?route=/dev/gallery`, and the dashboard pages.

| Surface | Tests (jest unless noted) | Screenshot reference |
| ------- | ------------------------- | -------------------- |
| Type, chrome | the variants' sizes and weights, no 700; header titles; `HeaderButton` and back chevron 44 pt and labelled; `screenOptions` sets the blur material; `ScreenScroll` sets automatic insets | popover header; host screen scrolled so a card sits under the status bar, light and dark |
| Welcome, first run | each state; the preview ticks only while focused and stops on blur; a still frame under Reduce Motion; the restore message on `key_changed`; removing the last host returns to welcome | desktop onboarding |
| Pairing | priming, denied, unavailable, paste, preview (with and without `can_hand_over`), waiting, success, each section 4.0 failure. The scanner itself is unverified until a device run: the simulator has no camera, and Paste covers it | "Pair iPhone" sheet |
| Hosts list | three columns and accents; autoscaled ceilings (5-25 % CPU draws under a 30 % ceiling); null buckets as gaps; offline dim and "Last seen"; per-host demo values; no gap on a live demo host; no `subscribeLive` call from the list | popover cards |
| Host screen | swatch header; CPU ceiling on the gridline; memory pressure line; power omission; compact unavailable row; network mirrored bars. Gesture paths, one test each: chevron tap toggles density and persists across remount; body tap opens the module; long-press-move reorders and persists; long-press-release opens the menu, and each menu item acts; VoiceOver Toggle compact, Move up, Move down and Open | popover |
| Module pages | ported sections render (Mac and Linux fixtures); stat values equal `@core/format` of selectors or the history answer's `stats`; ticks and gaps; scrub readout; process table sorted, at most 10 rows, interest only while focused; no omitted section's text present; the Network page shows no power event; colliding annotations form a second row or "+N"; the addresses header for known, pending (polled at most 5 times while visible), unavailable, unknown and an old host; Power & Sensors in °C and °F from a Celsius and a Fahrenheit locale | `/dashboard/<module>` |
| Settings | reorder persists across relaunch; swipe-delete asks and removes only on confirm, and cancel leaves the host; VoiceOver Move up/down reorders; host detail actions; Appearance checkmarks | dashboard settings |
| Shared models | `valueTicks`/`timeTicks` on percent, bytes, rate and watts and on 5m to 30d; the heat, ring and annotation models match the desktop output (desktop tests unchanged, `make e2e-perf` before and after) | dev gallery |
| Rust | none here: process interest is plan 8d's and the history query's tests are plan 7j1's and 7j2's | n/a |
| Device only | the Local Network prompt and the `local_network` error path, and the camera scanner, are marked "unverified on device" until a device run; the simulator enforces neither | n/a |
