# Plan: iPhone app foundations

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.4/shared/scripts/plan_graph.py
Started: 2026-11-25. Timebox: none. Landing branch: deliver/ios-foundations.
Worktree: /Users/riley/Projects/statglass/.claude/worktrees/deliver-ios-foundations
Gate: `make mobile-check && bun run check && make architecture-check architecture-test agent-config-check agent-config-test agent-hooks-test` (timed on the scaffold parent; see Log). Rust, bindings and App Store gates are left out because no Rust, Swift or generated file changes; the pre-push hook still runs them. Filtered tests: `bun run --cwd apps/mobile test -- <path>`. Typecheck: `bun run --cwd apps/mobile typecheck`.
Commits: conventional commit subjects are enforced by the commit hook (`type(scope): subject`).
Runner: plain commands.
Worktree setup: `bun install --frozen-lockfile && bun run --cwd apps/mobile routes:types`.
Executors: every lane is a foreman Codex run (model gpt-6.2-sol, high effort), one run per lane, with a contract built from the lane brief and `.claude/delegate.md`. The run leaves its work uncommitted; the orchestrator reviews the diff, commits it on the lane branch, runs `check-lane` and a lane review, then merges.

Source RFC: `plan/rfc-ios-foundations.md`. Section numbers below refer to it.

## Spec

Fix what the 2026-11-25 audit of `apps/mobile` found: text that renders in the wrong colour, the missing styling primitives behind it, the import cycle between the data layer and the native transport, the copied module-page prelude, and a test suite that replaces the mock transport instead of configuring it. Users see correct link and error colours; everything else is structure that the next module page or host feature builds on.

In scope:

- RFC 1: `Text` takes `tone`, `weight` and `tabular`; no caller passes a colour, weight or numeral class; no `!` modifier anywhere in `src`.
- RFC 2: rem stays 14; `--spacing-touch: 44px` token; a compile test pins both; the rule file says so; host page gutters match their neighbours.
- RFC 3: `Button` and `Card`/`PressableCard` primitives; every hand-rolled copy moves to them; `PairAction` and `CARD_SURFACE` are deleted.
- RFC 4: `data` never imports `transport` (Biome-enforced); `src/session/` holds the demo session, pairing and the selection intents; `useNativeHandle` replaces four copies.
- RFC 5: `useModulePage` and a series-driven `useModuleHistory` used by all six pages; shared `HistoryNotice`; `MODULE_TITLES`; power and battery stop importing each other's helpers.
- RFC 6: shared module-screen test helpers; `failNext` and scenarios instead of hand-built replies; gap and unavailable-history coverage; no assertions on Reanimated stub call arguments.
- RFC 7: one `useNiceCeiling`; `data/hosts.ts` split; dead exports removed; docs corrected; `noFloatingPromises` and `noImportCycles` on.

Out of scope: merging the three transport providers; a shared `TextInput`; unifying the not-live rules across module pages; moving static inline styles to classes; widget `useColorScheme()` lookups; the `after-pair` singleton; anything in Rust, Swift or the desktop UI.

Assumptions (user can override):

- rem stays at 14 rather than moving to 16, because every screen was tuned at 14.
- `Text` gets typed props rather than a tailwind-merge `cn()`.
- The three transport providers stay separate; only the import direction and the setter's callers change.
- A source-scan jest test enforces the styling conventions, since Biome cannot express them.

Error model: no new failure paths (RFC "Error model"). History read failures stay typed `CommandError`s rendered by `HistoryNotice`; native startup failures stay in `CoreProvider`; `useSelectNativeCore` is a no-op when the core is not ready; a hook outside its provider throws an `Error` naming the hook and the provider. No lane adds a catch that returns a default.

## Contracts (scaffold commit)

Signatures are in the RFC (sections 1, 3, 4, 5). Layout of new and moved paths under `apps/mobile/`:

    src/ui/text.tsx                 Text roles; owns colour (tone), weight and numerals
    src/ui/button.tsx               Button: primary, secondary and link actions
    src/ui/card.tsx                 Card and PressableCard: the card surface
    src/global.css                  adds the --spacing-touch token
    src/session/demo.ts             demo session provider and transport (from data/demo.ts)
    src/session/pairing.tsx         pairing provider and phone key read (from data/pairing-context.tsx)
    src/session/selection.ts        useSelectNativeCore, useClearTransport
    src/transport/native-handle.ts  useNativeHandle
    src/module/use-module-page.ts   the state every module page starts from
    src/module/rings/               ring cards and the watt ring ceiling shared by power and battery
    src/module/event-labels.ts      temperature-aware event labels
    src/data/nice-ceiling.ts        the phone's ceiling latch over core's nextCeiling
    src/hosts/row-sparkline.ts      the hosts-list row sparkline pipeline (from data/hosts.ts)
    test/helpers/module-screen.tsx  module-screen test helpers for every module
    test/helpers/worklets-mock.ts   the one worklets mock
    test/ui/style-conventions.test.ts  source scan for the styling rules

Phase 1 scaffold (inline, before dispatch): the `tone`, `weight` and `tabular` props declared on `TextProps` and ignored; throwing stubs for `Button`, `Card` and `PressableCard`; phase 1's tests; `noFloatingPromises` and `noImportCycles` in `biome.json`, with the one finding (`src/app/hooks/use-open-in-timeline.ts`) fixed.

Each scaffold commits tests for every lane of its phase, so a lane's worktree holds the other lanes' failing tests until the phase lands. A lane is done on its own filtered tests; when it runs the whole mobile suite, the files its brief names as another lane's are expected to fail and nothing else is. The full gate runs on the landing branch after the phase's last merge.

## Phases

### Phase 1: text renders in the colour it asks for (MVP)

Demo: Metro from this worktree with the simulator's Debug build, demo mode, open MacBook Pro, CPU, touch and hold the chart: "Clear pin" is cyan in light and dark. A history error on a module page is red.
Scaffold: c1ec941b

Test cases:

- Text: each variant keeps its size, weight, rounded family, tabular numerals and header role (existing table).
- Text: with no `tone`, label, caption and axis emit `text-muted-foreground` and nothing else from the colour set; the other variants emit `text-foreground`.
- Text: each of the eight tones emits exactly its one class, on a muted variant and on a default variant, and never the variant's default colour beside it.
- Text: `weight="semibold"` on body sets font weight 600; `weight="regular"` on cardTitle sets 400; no weight class is emitted.
- Text: `tabular` on caption adds tabular numerals; a variant that already has them is unchanged.
- Text: a caller's layout `className` is kept after the tone class.
- Text: the caller's `style` still wins over `weight`.
- Source scan: no `<Text>` opening tag in `src` (including conditional spreads and ternaries inside it, and not `TextInput`) carries a theme colour utility, a `font-<weight>` class or `tabular-nums`; no class in `src` uses the `!` modifier.
- Button: renders its label as a button; `onPress` fires once per press; `disabled` blocks `onPress` and reports the disabled state; `accessibilityLabel` overrides the name and `accessibilityHint` and `testID` pass through; primary and secondary have their surface and the 44 pt minimum, link has the target and no surface; the caller's layout classes are kept.
- Button, after both lanes merge (added inline): the primary label renders `text-primary-foreground` and the link label `text-link`, each as its only colour class.
- Card: renders children inside the card surface with each padding; keeps the caller's classes and view props; `PressableCard` is one button that fires `onPress` and does not fire while disabled.
- Touch token: compiled through the real pipeline, `min-h-touch` is 44 and `px-4` is 14.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/src/ui/text.tsx, apps/mobile/src/cards/battery-card.tsx, apps/mobile/src/connection/problem-banner.tsx, apps/mobile/src/debug/debug-screen.tsx, apps/mobile/src/handover/choices.tsx, apps/mobile/src/handover/pair-selection.tsx, apps/mobile/src/handover/update-flow.tsx, apps/mobile/src/handover/update-selection.tsx, apps/mobile/src/host/connection-pill.tsx, apps/mobile/src/hosts/host-row.tsx, apps/mobile/src/hosts/hosts-list.tsx, apps/mobile/src/lock/app-lock-gate.tsx, apps/mobile/src/module/events-list.tsx, apps/mobile/src/module/module-chart.tsx, apps/mobile/src/module/module-frame.tsx, apps/mobile/src/module/module-notice.tsx, apps/mobile/src/module/pages/network/history-chart.tsx, apps/mobile/src/pairing/screens/action.tsx, apps/mobile/src/pairing/screens/pairing-step.tsx, apps/mobile/src/pairing/screens/paste.tsx, apps/mobile/src/ui/retry-panel.tsx, apps/mobile/src/ui/sheet.tsx, apps/mobile/src/widgets/gap-bands.tsx, apps/mobile/src/widgets/inline-bar.tsx, apps/mobile/src/widgets/stack-bar.tsx, apps/mobile/src/widgets/stat-list.tsx, apps/mobile/src/widgets/stream-area.tsx | RFC 1, apps/mobile/src/theme.generated.css | apps/mobile/test/ui/text.test.tsx | gpt-6.2-sol | running | foreman/iosf-1a | text tests pass; the mobile suite fails only in lane b's two test files |
| b | S | apps/mobile/src/ui/button.tsx, apps/mobile/src/ui/card.tsx, apps/mobile/src/global.css, apps/mobile/test/spacing-scale.test.mjs | RFC 2 and 3, apps/mobile/src/pairing/screens/action.tsx, apps/mobile/src/cards/module-card.tsx | apps/mobile/test/ui/button.test.tsx, apps/mobile/test/ui/card.test.tsx | gpt-6.2-sol | running | foreman/iosf-1b | button, card and spacing tests pass |

#### Lane a brief

- Goal: make `Text` the only place a text colour, weight or numeral style is chosen, so a caller's colour can no longer lose to the variant's default, and move every call site to the new props.
- Interface: `TextTone`, `TextProps.tone`, `TextProps.weight`, `TextProps.tabular` exactly as in RFC section 1 (already declared in `src/ui/text.tsx` by the scaffold and ignored). Tone to class: default `text-foreground`, muted `text-muted-foreground`, subtle `text-fg-subtle`, faint `text-fg-faint`, link `text-link`, destructive `text-destructive`, warning `text-warning-ink`, onPrimary `text-primary-foreground`.
- Behavior:
  - With no `tone`, label, caption and axis use muted and every other variant uses default (today's behaviour).
  - `Text` emits exactly one colour class, then the caller's `className`. An empty or absent `className` emits the colour class alone.
  - `weight` sets `fontWeight` in the style array after the variant's typography ("regular" 400, "semibold" 600) and before the caller's `style`. No weight class is emitted.
  - `tabular` adds `fontVariant: ["tabular-nums"]` the same way. Variants that already have it are unchanged.
  - Every `<Text>` in the owned files that passes a theme colour class (`text-foreground`, `text-muted-foreground`, `text-fg-subtle`, `text-fg-faint`, `text-link`, `text-destructive`, `text-warning-ink`, `text-primary-foreground`, with or without `!`) passes `tone` instead. A conditional class becomes a conditional tone (`tone={error ? "destructive" : undefined}`).
  - Every `font-semibold!` becomes `weight="semibold"`. Every `tabular-nums` class becomes `tabular`, and an inline `fontVariant` style that only repeats what the variant or `tabular` now gives is removed.
  - Layout classes (`text-center`, `text-right`, `shrink`, `self-end`, padding) stay in `className`. `text-[17px]` and colour classes on non-`Text` elements (`TextInput`, `View`) are not part of this lane.
  - After the lane, `grep -rnE '[a-z\]]!["\s`]' apps/mobile/src` finds no `!` class modifier.
- Decisions already made: typed props, not a `cn()` or tailwind-merge (RFC 1). The colour stays a class from the theme tokens, not an inline style from the JS colour map. `accessibilityRole="header"` for heading variants is unchanged.
- Out of scope: `Button` and `Card` (lane b); replacing `min-h-[44px]`; changing which tone a site should have (keep each site's intended colour, including the six that render wrong today because their class lost); any new variant or tone beyond the eight.
- Done when: `bun run --cwd apps/mobile test -- test/ui/text.test.tsx` passes; `bun run --cwd apps/mobile test` fails only in `test/ui/button.test.tsx` and `test/ui/card.test.tsx` (lane b's stubs); `bun run --cwd apps/mobile typecheck` and `bunx biome check apps/mobile` are clean.

#### Lane b brief

- Goal: add the `Button` and `Card` primitives and the 44 px touch-target token, without adopting them anywhere yet.
- Interface: `ButtonProps` and `Button` in `src/ui/button.tsx`; `CardProps`, `Card` and `PressableCard` in `src/ui/card.tsx`, exactly as in RFC section 3 (stubbed by the scaffold). `src/global.css` gains `@theme { --spacing-touch: 44px; }`.
- Behavior:
  - `Button` is a `Pressable` with `accessibilityRole="button"`, `accessibilityState={{ disabled }}`, `disabled`, and `active:opacity-70`. Its label is a `Text` with variant body.
  - primary: `min-h-touch items-center justify-center rounded-xl bg-primary px-4 py-2`; label `tone="onPrimary"`, `weight="semibold"`, centred.
  - secondary: the same shape with `border border-border bg-card` instead of `bg-primary`; label default tone, centred.
  - link: `min-h-touch min-w-touch justify-center` with no surface; label `variant="label"`, `tone="link"`.
  - `disabled` adds `opacity-50` and `onPress` does not fire.
  - `className` is appended for layout only.
  - `Card` is a `View` with `overflow-hidden rounded-xl border border-border bg-card` plus padding: none adds nothing, md `p-3` (default), lg `p-4`; the caller's `className` is appended; other `ViewProps` pass through.
  - `PressableCard` is the same surface on a `Pressable` with `accessibilityRole="button"`, `min-h-touch` and `active:opacity-70`.
  - `test/spacing-scale.test.mjs` (a `node --test` file, like `test/theme-tokens.test.mjs`) compiles `src/global.css` the way Metro does, `postcss` with `@tailwindcss/postcss` and then `compile` from `react-native-css/node/compiler.mjs`, and asserts on the compiled stylesheet that `min-h-touch` resolves to 44 and `px-4` to 14. It never asserts on source text.
- Decisions already made: rem stays 14 (RFC 2). The label's `tone` and `weight` come from lane a's `Text`; in this lane's worktree those props are declared and ignored, so the label's colour is tested after both lanes merge, not here.
- Out of scope: replacing any existing button, card or `min-h-[44px]` (phase 2); deleting `PairAction` or `CARD_SURFACE`; a `TextInput` primitive; icons, loading states or sizes on `Button`.
- Done when: `bun run --cwd apps/mobile test -- test/ui/button.test.tsx test/ui/card.test.tsx` and `node --test apps/mobile/test/spacing-scale.test.mjs` pass; `bun run --cwd apps/mobile test` fails only in `test/ui/text.test.tsx` (lane a's work); `bun run --cwd apps/mobile typecheck` and `bunx biome check apps/mobile` are clean.

### Phase 2: every screen uses the primitives

Demo: the hosts list, a host screen, a module page, Settings and the pairing flow look the same as before in the simulator, light and dark.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/src/hosts/, apps/mobile/src/host/, apps/mobile/src/connection/, apps/mobile/src/welcome/, apps/mobile/src/lock/, apps/mobile/src/app/, apps/mobile/test/hosts/, apps/mobile/test/host/, apps/mobile/test/connection/, apps/mobile/test/welcome/, apps/mobile/test/first-launch.test.tsx | RFC 2 and 3, apps/mobile/src/ui/button.tsx, apps/mobile/src/ui/card.tsx | | gpt-6.2-sol | pending | | owned folders have no hand-rolled button, card surface or 44px literal |
| b | M | apps/mobile/src/module/, apps/mobile/test/module/ | RFC 2 and 3, apps/mobile/src/ui/button.tsx, apps/mobile/src/ui/card.tsx | | gpt-6.2-sol | pending | | owned folders have no hand-rolled button, card surface or 44px literal |
| c | M | apps/mobile/src/settings/, apps/mobile/src/pairing/, apps/mobile/src/handover/, apps/mobile/src/debug/, apps/mobile/src/cards/, apps/mobile/src/widgets/, apps/mobile/src/ui/, apps/mobile/test/settings/, apps/mobile/test/pairing/, apps/mobile/test/handover/, apps/mobile/test/debug/, apps/mobile/test/cards/, apps/mobile/test/widgets/, apps/mobile/test/ui/ | RFC 2 and 3, apps/mobile/src/ui/button.tsx, apps/mobile/src/ui/card.tsx | | gpt-6.2-sol | pending | | owned folders have no hand-rolled button, card surface or 44px literal |

Inline after the three lanes merge, before the gate: delete `PairAction` (`src/pairing/screens/action.tsx`) and `CARD_SURFACE` (`src/cards/module-card.tsx`), which no single lane can remove because their importers span all three; add the rem and touch-token note to `.claude/rules/mobile/expo.md` and run `make agent-config`. The scaffold's `test/ui/style-conventions.test.ts` is expected to fail in every lane's worktree and pass on the landing branch after the merges.

Test cases (`apps/mobile/test/ui/style-conventions.test.ts`, a source scan over `apps/mobile/src`):

- No class in `src` contains `[44px]`.
- No `View`, `Pressable` or `Animated.View` opening tag outside `src/ui/card.tsx` and `src/ui/button.tsx` carries `rounded-xl`, `border-border` and `bg-card` together.
- No opening tag outside `src/ui/button.tsx` carries a `rounded-*` class together with `bg-primary` (a hand-rolled filled button).
- No file in `src` names `PairAction` or `CARD_SURFACE` (passes after the inline deletion).
- Every existing screen test passes unchanged, apart from `test/handover/pair.test.tsx`, which renders `Button` where it rendered `PairAction`.

Rules shared by the three lanes:

- Replace every `min-h-[44px]` with `min-h-touch` and every `min-w-[44px]` with `min-w-touch`.
- A `View` whose classes include the card surface (`rounded-xl border border-border bg-card`, or `CARD_SURFACE`) becomes `<Card>`: `p-3` is the default padding, `p-4` is `padding="lg"`, anything else is `padding="none"` with the padding left in `className`. A `Pressable` with the surface becomes `<PressableCard>`. Both add `overflow-hidden`, which is intended.
- `<PairAction>` becomes `<Button>` (`secondary` becomes `variant="secondary"`). A hand-rolled filled button (a `Pressable` with `rounded-xl` or `rounded-lg` and `bg-primary` wrapping one `Text`) becomes `<Button>`; the `rounded-lg` one becoming `rounded-xl` and its label centring are accepted differences.
- A text-only `Pressable` with `min-h-[44px] min-w-[44px] justify-center active:opacity-70` around one `<Text variant="label" tone="link">` becomes `<Button variant="link">`. Any other text-only `Pressable` (different text variant, padding, weight or disabled styling) keeps its `Pressable` and only gets the token.
- Accessibility props (`accessibilityLabel`, `accessibilityHint`, `accessibilityState`, `testID`) carry over exactly. A site that needs a prop `Button` does not have keeps its `Pressable` and is listed in the hand-off.
- Do not delete or edit the definitions of `PairAction` (`src/pairing/screens/action.tsx`) or `CARD_SURFACE` (`src/cards/module-card.tsx`); the orchestrator removes them after all three lanes merge.
- `TextInput`s, the `rounded-full` connection pill and the `rounded` chart annotation chip are not cards and stay as they are.

#### Lane a brief

- Goal: the hosts list, host screen, connection banner, welcome screen, lock gate and routes use `Button`, `Card` and the touch token.
- Behavior: the shared rules above, in the owned folders. Known sites: the "Add a host" filled button and the text-only action beside it in `hosts/hosts-list.tsx`; the host row card in `hosts/host-row.tsx` (`PressableCard`, `className="gap-2"`); the unlock button and its card in `lock/app-lock-gate.tsx`; `PairAction` in `welcome/welcome-screen.tsx` and `app/pair-hosts.tsx`; the banner action in `connection/problem-banner.tsx` (token only). In `host/host-page.tsx` the content's horizontal padding moves from the StyleSheet's 16 to the `px-4` class its neighbours use.
- Out of scope: the files other lanes own; any change to `Button` or `Card` themselves.
- Done when: the filtered tests for the owned test folders pass; the mobile suite fails only in `test/ui/style-conventions.test.ts`; typecheck and Biome are clean; the hand-off lists every site left as a `Pressable` and why.

#### Lane b brief

- Goal: the module pages use `Card`, `Button` and the touch token.
- Behavior: the shared rules above, in `src/module/`. Known sites: the card surfaces in `pages/cpu/index.tsx`, `pages/cpu/core-load.tsx`, `pages/gpu/index.tsx`, `pages/gpu/frequency.tsx`, `pages/memory/index.tsx`, `pages/network/index.tsx`; the `CARD_SURFACE` users in `pages/power/index.tsx`, `pages/power/thermal-history.tsx`, `pages/power/ring-cards.tsx` and `pages/battery/battery-day.tsx` (the ring card keeps its width classes in `className`); the three link buttons in `module-notice.tsx`, `module-chart.tsx` and `pages/network/history-chart.tsx`.
- Out of scope: the module-page prelude and history hooks (phase 3); `CardGlow`.
- Done when: `bun run --cwd apps/mobile test -- test/module` passes; the mobile suite fails only in `test/ui/style-conventions.test.ts`; typecheck and Biome are clean.

#### Lane c brief

- Goal: settings, pairing, handover, the debug screen, the popover cards and the shared `ui` components use `Button`, `Card` and the touch token.
- Behavior: the shared rules above, in the owned folders. Known sites: every `PairAction` in `pairing/` and `handover/` and in `test/handover/pair.test.tsx`; the card surfaces in `pairing/screens/preview.tsx`, `handover/update-selection.tsx`, `handover/choices.tsx` (`PressableCard`, `padding="none"`) and `debug/debug-screen.tsx`; `cards/module-card.tsx` and `cards/unavailable-card.tsx` render through `Card`/`PressableCard` while `CARD_SURFACE` stays exported; the Retry button in `ui/retry-panel.tsx` and the Connect button in `debug/debug-screen.tsx`; tokens in `settings/`, `ui/reorder-list.tsx`, `ui/segmented-control.tsx` and `ui/sheet.tsx`.
- Out of scope: `ui/button.tsx`, `ui/card.tsx` and `ui/text.tsx` themselves; inline `minHeight: 44` styles (`ui/demo-badge.tsx`, `ui/swipe-row.tsx`).
- Done when: the filtered tests for the owned test folders pass; the mobile suite fails only in `test/ui/style-conventions.test.ts`; typecheck and Biome are clean.

### Phase 3: data, session and module boundaries

Demo: first launch, demo mode in and out, a module page per module and the hosts list behave as before in the simulator; `bunx biome check apps/mobile` rejects an `@/transport` import added under `src/data`.
Depends on: phase 2

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/src/session/, apps/mobile/src/data/demo.ts, apps/mobile/src/data/pairing-context.tsx, apps/mobile/src/data/transport-context.tsx, apps/mobile/src/transport/, apps/mobile/src/app/, apps/mobile/src/pairing/index.tsx, apps/mobile/src/pairing/flow.ts, apps/mobile/src/hosts/hosts-list.tsx, apps/mobile/src/hosts/first-launch-redirect.tsx, apps/mobile/src/debug/use-debug-connection.ts, apps/mobile/src/settings/data-settings.tsx, apps/mobile/src/settings/device-settings.tsx, apps/mobile/src/welcome/welcome-screen.tsx, apps/mobile/src/lib/providers.tsx, apps/mobile/src/ui/startup-failure.tsx, apps/mobile/test/render.tsx, apps/mobile/test/data/seam.test.tsx, apps/mobile/test/handover/pair.test.tsx, apps/mobile/test/pairing/, apps/mobile/test/welcome/, biome.json, scripts/architecture/test_biome_rules.py | RFC 4 | | gpt-6.2-sol | pending | | data never imports transport and the suite passes |
| b | M | apps/mobile/src/module/, apps/mobile/src/data/history.ts, apps/mobile/src/data/live-stream.ts, apps/mobile/src/data/nice-ceiling.ts, apps/mobile/src/host/card-stack.tsx, packages/core/README.md, apps/mobile/test/app/query-client.test.tsx, apps/mobile/test/demand/screen-demand.test.tsx | RFC 5 and 7 | | gpt-6.2-sol | pending | | all six pages use useModulePage and useModuleHistory and the suite passes |
| c | S | apps/mobile/src/data/hosts.ts, apps/mobile/src/hosts/row-sparkline.ts, apps/mobile/src/hosts/sparkline-model.ts | RFC 7 | | gpt-6.2-sol | pending | | data/hosts.ts holds only roster and status queries and the suite passes |

Scaffold: `src/hosts/row-sparkline.ts` re-exports `useHostSparkline` from `@/data/hosts`, and its three importers (`src/hosts/host-row.tsx`, `test/hosts/hosts-list.test.tsx`, `test/demand/screen-demand.test.tsx`) move to the new path, so lane c moves the implementation without touching a file lane a or b owns. The Biome boundary cannot be in the scaffold, because `data` still imports `transport` there; lane a adds it with its fixtures once its own moves make it true.

(Test cases and briefs written during phase 2.)

### Phase 4: tests configure the mock transport

Demo: `bun run --cwd apps/mobile test` passes with the new gap and unavailable-history cases, and `grep -rn 'mock.results' apps/mobile/test/ui apps/mobile/test/widgets` finds nothing.
Depends on: phase 3

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/test/module/, apps/mobile/test/helpers/module-screen.tsx | RFC 6 | | gpt-6.2-sol | pending | | module tests use the shared helpers and scenarios |
| b | M | apps/mobile/test/hosts/, apps/mobile/test/data/, apps/mobile/test/connection/, apps/mobile/test/demand/, apps/mobile/test/host/host-screen.test.tsx | RFC 6 | | gpt-6.2-sol | pending | | hand-built replies replaced and gap cases added |
| c | M | apps/mobile/test/ui/, apps/mobile/test/widgets/, apps/mobile/test/settings/hosts.test.tsx, apps/mobile/test/host/card-stack.test.tsx, apps/mobile/test/reanimated-stub.ts | RFC 6 | | gpt-6.2-sol | pending | | no assertion reads a Reanimated stub's call arguments |
| d | S | apps/mobile/test/app/, apps/mobile/test/debug/, apps/mobile/test/first-launch.test.tsx, apps/mobile/test/handover/, apps/mobile/test/pairing/, apps/mobile/test/settings/host-detail.test.tsx, apps/mobile/test/settings/persistence.test.tsx | RFC 6 | | gpt-6.2-sol | pending | | command failures come from failNext where the mock can produce them |

(Test cases and briefs written during phase 3. Inline in this phase: `test/helpers/worklets-mock.ts` in the scaffold, the docs in RFC 7 and `make agent-config`. `test/transport/` builds reply envelopes by hand because the envelope is what it tests, and stays as it is; so do the `mock.results` reads outside `test/ui` and `test/widgets`, none of which is a Reanimated stub.)

## Log
- 2026-11-25: gate timed on the untouched landing branch (cd73d960): all three parts exit 0 in 184 s wall.
- 2026-11-25: plan critique (opus devils-advocate) returned eight findings; all held against the code. Applied: lanes are done on their filtered tests with the other lanes' red files named (1); the `PairAction`/`CARD_SURFACE` deletion and the rem note are inline after phase 2's merges (2, 4); phase 3's scaffold moves `useHostSparkline`'s import path so lane c touches no shared test (3); lane 3/a owns `biome.json` and its fixtures and repeats the inherited restriction lists (4); phase 4's demo grep is narrowed and lane d covers the remaining hand-built failures (5); RFC 4 names the three `useNativeHandle` copies, why `update-from-mac` is safe, the three sites that stay, and `useSelectNativeCore` returns whether it swapped (6); RFC 5 keeps the power accent, `useHostHistory` and `useRefreshOnRangeChange`, and names the two tests that change (7); the Text scan reads whole opening tags and skips `TextInput` (8).
