# RFC: iPhone app foundations

Status: draft for review, 2026-11-25. Execution plan: `plans/deliver-ios-foundations.md`.

## Summary

An audit of `apps/mobile` after the iPhone app landed found the TypeScript, Biome and Expo
setup in good order and six problems in the layers above them: one visible styling bug, two
styling-foundation gaps, two architecture problems and one test-suite pattern. This RFC
fixes all six plus the small items found beside them. Nothing here changes what the app
does for a user, apart from text that currently renders in the wrong colour.

The work is TypeScript and documentation only. No Rust, Swift, native module, wire format
or generated file changes, and the desktop app is untouched except where a repo-wide lint
rule is turned on.

## 1. `Text` owns its colour, weight and numerals

### Problem

`apps/mobile/src/ui/text.tsx:70` prepends `text-foreground` or `text-muted-foreground` to
whatever class the caller passes. react-native-css resolves two rules of equal specificity
by stylesheet order (`node_modules/react-native-css/src/utilities/specificity.ts`), and
Tailwind emits colour utilities alphabetically, so a caller's colour wins only when its
name sorts after the baked one. `text-link` and `text-destructive` on a muted variant lose.

Confirmed in the iOS Simulator (Release build, demo mode): "Clear pin" on a module chart
asks for `text-link` (#0891b2) and renders muted grey. Six call sites are affected today.
Twenty more carry an `!` important modifier as a workaround (`text-destructive!` 12,
`text-primary-foreground!` 4, `font-semibold!` 8, because weight lives in inline style and
a class can never beat it). `tabular-nums` as a class compiles to nothing in react-native-css,
and four sites still use it.

### Decision

`Text` takes the colour, weight and numeral style as props and emits exactly one colour
class. Callers never pass a colour, weight or numeral class.

```ts
export type TextTone =
  | "default"      // text-foreground
  | "muted"        // text-muted-foreground
  | "subtle"       // text-fg-subtle
  | "faint"        // text-fg-faint
  | "link"         // text-link
  | "destructive"  // text-destructive
  | "warning"      // text-warning-ink
  | "onPrimary";   // text-primary-foreground

export type TextProps = Omit<NativeTextProps, "role"> & {
  variant: TextVariant;
  /** Defaults to "muted" for label, caption and axis, "default" otherwise. */
  tone?: TextTone;
  /** Overrides the variant's weight. */
  weight?: "regular" | "semibold";
  /** Adds tabular numerals to a variant that does not have them. */
  tabular?: boolean;
};
```

`className` stays for layout (`shrink`, `text-center`, `self-end`). A source-scan test,
next to the one `test/ui/text.test.tsx` already has for `role`, fails when a `<Text>`
carries a colour utility from the theme, a `font-<weight>` class or `tabular-nums`, and
when any class in `src` uses the `!` modifier.

Not chosen: a `cn()` built on tailwind-merge, as the desktop has. It would fix the conflict
at runtime, but it adds a dependency and a merge call on every `Text` render for a problem
a typed prop removes, and it would still leave weight in two places.

## 2. rem is 14 dp, written down, with a touch-target token

### Problem

`withNativewind` runs without `inlineRem`, and react-native-css defaults it to 14
(`src/compiler/declarations.ts:1426`). So `px-4` is 14 dp and `min-h-11` is 38.5 dp, which
is why 26 of the app's 31 arbitrary-value classes are `min-h-[44px]` or `min-w-[44px]`.
No rule mentions it. `src/host/host-page.tsx` uses 16 dp gutters from a StyleSheet while
the hosts list, settings and module screens use `px-4`.

### Decision

Keep 14. Every screen was tuned in the simulator at this scale, and
`.claude/rules/mobile/expo.md` already says spacing is the phone's own. The change:

- `src/global.css` gains `@theme { --spacing-touch: 44px; }`, giving `min-h-touch`,
  `min-w-touch` and `size-touch`. Every `min-h-[44px]` and `min-w-[44px]` becomes the token.
- A node test compiles `global.css` through the real pipeline and pins `min-h-touch` at 44
  and `px-4` at 14, so a NativeWind upgrade that changes the default fails a test instead
  of shifting every screen.
- `.claude/rules/mobile/expo.md` states the rem and the token.
- The host page's gutters use `px-4` like its neighbours.

## 3. `Button` and `Card` primitives

### Problem

The card surface (`rounded-xl border border-border bg-card`) is written out at 17 sites and
exported as a string constant, `CARD_SURFACE`, from `src/cards/module-card.tsx`. The primary
button is hand-rolled five times (one with `rounded-lg`), and the text-link button
(`min-h-[44px] min-w-[44px] justify-center active:opacity-70`) five more. `PairAction` in
`src/pairing/screens/action.tsx` is already a general button and is imported by welcome,
handover and a route.

### Decision

Two primitives in `src/ui/`, and every copy moves to them.

```ts
// src/ui/button.tsx
export interface ButtonProps {
  label: string;
  onPress(): void;
  /** primary: filled. secondary: bordered card surface. link: text only. */
  variant?: "primary" | "secondary" | "link";
  disabled?: boolean;
  /** Layout only (width, alignment, margin). */
  className?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

// src/ui/card.tsx
export type CardProps = ViewProps & {
  /** Inner padding: "none", "md" (p-3, the default) or "lg" (p-4). */
  padding?: "none" | "md" | "lg";
};
export function Card(props: CardProps): JSX.Element;
/** The same surface on a Pressable, for a card that is one touch target. */
export function PressableCard(props: PressableProps & { padding?: CardProps["padding"] }): JSX.Element;
```

`Card` and `PressableCard` clip their content (`overflow-hidden`), as `CARD_SURFACE` does.
`PairAction` and `CARD_SURFACE` are deleted once nothing imports them.

Not included: a shared `TextInput`. The three inputs are a multi-line monospace field, a
borderless row inside a grouped list and a dev-only debug field. They share a font size and
nothing else, so a primitive would be three variants with one user each.

## 4. The data layer does not import the native transport

### Problem

`src/data` defines the `PhoneTransport` seam and the context that carries the chosen
transport. `src/transport` implements the native one. They import each other:
`data/demo.ts` and `data/pairing-context.tsx` import `@/transport`, and three files in
`transport/` import `@/data`. Nothing enforces a direction.

Around that, `useSetPhoneTransport()` is called from six folders (`pairing`, `transport`,
`app`, `hosts`, `data`, `debug`), each deciding for itself when the active transport
changes. And three files (`data/pairing-context.tsx`, `settings/data-settings.tsx`,
`transport/native-core-bridge.tsx`) repeat `core ?? (isNativeTransport(transport) ? transport : null)`
to find the native handle, because the native-only calls (data policy, key line, handover)
are not on the seam.

### Decision

1. Direction: `transport` may import `data`; `data` never imports `transport`. Biome
   enforces it with a `noRestrictedImports` override on `apps/mobile/src/data/**`. Biome
   override options replace the inherited list, so the new block repeats every restriction
   the `apps/mobile/src/**` block carries (`react-dom`, `@tauri-apps/**`, the desktop
   aliases, parent-relative imports, `@native/**`) and adds `@/transport` and
   `@/transport/**`. `scripts/architecture/test_biome_rules.py` gains a fixture that an
   `@/transport` import under `src/data` is rejected and one that the same import under
   `src/session` is allowed, and that `@native/**` is still rejected under `src/data`.
2. A new `src/session/` folder holds the code that composes the two: the demo session
   (`DemoProvider`, `useDemo`, `createDemoTransport`, from `data/demo.ts`) and pairing
   (`PairingProvider`, `usePhonePairing`, `usePhonePublicKey`, `isDemoPairingCode`, from
   `data/pairing-context.tsx`). `data/pairing-seam.ts` stays; it is a contract.
3. `src/transport/` exports `useNativeHandle(): NativeTransport | null`, which returns the
   started core, or the selected transport when that is native. The three copies use it,
   and so does `app/update-from-mac.tsx`, which today prefers the selected transport over
   the core. The order does not matter there: `CoreProvider` clears a native selection
   before it disposes the core, so a selected native transport is always the started core.
   Three sites read only the selected transport on purpose and keep `isNativeTransport`:
   `app/pair-hosts.tsx`, `app/index.tsx` and `settings/host-removal.ts`.
4. Screens stop calling the raw setter. `src/session/` exports intents, and
   `useSetPhoneTransport` is imported only by `session/`, `transport/` and `debug/`:

```ts
// src/session/selection.ts
/**
 * Makes the started native core the active transport. Returns whether it changed the
 * selection: false when the core is not ready or is already selected.
 */
export function useSelectNativeCore(): () => boolean;
/** Clears the active transport if it is still `expected`, for a roster that emptied. */
export function useClearTransport(): (expected: PhoneTransport) => void;
```

`CoreProvider` stays in `transport/` (it starts the native core and is the only code that
may import `@native/*`), and `PhoneTransportProvider` stays in `data/`.

Not chosen: merging `PhoneTransportProvider`, `CoreProvider` and `DemoProvider` into one
owner. Each holds one thing (the choice, native startup, a demo session), the startup
sequence between them is race-sensitive and covered by 376 lines of `core-provider` tests,
and the app is about to be submitted. The cycle and the scattered setter calls are the
defects; three providers are not.

Out of scope: `settings/host-removal.ts` branching on native versus demo. Removing a host
means different things on each (a host-side removal versus hiding a demo host), at one
call site.

## 5. Module pages share one prelude and one history hook

### Problem

The six pages under `src/module/pages/` each repeat the same opening lines: range state,
plot width state, the host record lookup, `connected`, the clock offset, `useHistoryRange`
and `useConnection`. Beyond that:

- `useModuleHistory` (`data/history.ts`) derives its series from
  `HISTORY_MODULES[module].series`, so the GPU and memory pages, which read other series,
  hand-roll the same hook around `useHostHistory` and `useRefreshOnRangeChange`
  (`module/history-notice.tsx`).
- `HistoryNotice` exists in `module/history-notice.tsx` and is copied verbatim into the
  memory and network pages.
- The events-in-range filter is inlined in four pages; the hook for it lives under
  `pages/power/` and battery imports it from there.
- `useFocusDemand(host, "full")` is a side effect hidden inside `useModuleHistory`, so the
  two pages that do not use it call it by hand.
- Power and battery import each other.
- `HISTORY_MODULES` carries `accent`, `series`, `format` and `ceiling`; once pages pass
  their own series, `title` is the only field read outside the power page, which also
  reads `accent`. `ModulePageProps.module` is passed and never read.

### Decision

```ts
// src/module/use-module-page.ts
export interface ModulePage {
  windowMs: number;
  setWindowMs(ms: number): void;
  width: number | null;
  setWidth(width: number): void;
  /** The host's roster record, undefined until the roster loads. */
  record: HostRecord | undefined;
  /** Whether the remote session is connected (true for a host with no remote status). */
  connected: boolean;
  connection: Connection;
  live: boolean;
  /** Rolling, so pages read the host's clock offset from it. */
  range: RollingHistoryRange;
}
/** The state every module page starts from. Also registers full demand for the host. */
export function useModulePage(
  host: HostId,
  remote: PhoneRemoteHostStatus | undefined,
  defaultRange: number
): ModulePage;

// src/data/history.ts
export interface ModuleRead {
  /** The module whose events the reply carries. */
  module: Module;
  selection: readonly SeriesSelector[];
  /** The series keys the grid is built from; often a subset of the selection. */
  gridKeys: readonly string[];
}
/** One module's buckets, grid and in-range events, refreshed when the range changes. */
export function useModuleHistory(
  host: HostId,
  read: ModuleRead,
  range: HistoryRange,
  width: PlotWidth,
  enabled: boolean
): HostHistoryQuery & {
  data: HostHistoryPage | undefined;
  grid: HistoryGrid | null;
  displayedRange: HistoryRange;
  events: readonly Event[] | undefined;
};
```

All six pages use both. `useModuleHistory` no longer calls `useFocusDemand`;
`useModulePage` does, once. The memory and network pages use the shared `HistoryNotice`.
`HISTORY_MODULES` becomes `MODULE_TITLES: Record<PopoverCard, string>`, and the power
page names its accent (`"power"`) the way the other five pages name theirs.
`useHostHistory` and `useRefreshOnRangeChange` stay: the secondary charts (`cpu/core-load`,
`power/thermal-history`, `battery/battery-day`) read their own series with them. The pieces power
and battery share (ring cards, the watt ring ceiling, the temperature event label) move to
`src/module/rings/` and `src/module/event-labels.ts`, leaving one import from power to
battery (the embedded battery day card).

This is a refactor: every test under `test/module` passes unchanged. Two tests outside it
call `useModuleHistory` directly (`test/app/query-client.test.tsx`,
`test/demand/screen-demand.test.tsx`) and move to the new signature. Three things the audit
noticed are left alone because fixing them changes behaviour and needs a product call:
the three different rules for what a page shows when it is not live, where each page
subscribes to live data, and whether the power and battery pages re-render at tick rate
(not measured).

## 6. Tests use the mock transport's scenarios

### Problem

The mobile suite is 597 tests in 16.5 s with no mocks of app or core modules. But it
replaces the mock transport more than it configures it: 175 `jest.spyOn` calls, 297 mock
implementations, 42 hand-built `status: "error"` replies in 21 files against 25 uses of
the mock's own `failNext`, and scenarios that exist in `@core/mock/fixtures` and are never
used by the phone (`sleep-gap`, `history-corrupt`, `history-too-new`, `history-trimmed`,
`stale`, `clock-step`). Module-screen setup is copied across seven files although
`test/module/cpu/fixtures.tsx` has the helpers. Drag and animation tests assert on the
arguments the Reanimated stub was called with, including `mock.results` index lookups.
The only gap reason any phone test renders is `paused`.

### Decision

- `test/helpers/module-screen.tsx` holds the module-screen helpers for every module
  (`openModule`, `setModuleClock`, `layoutChart`, `watchHistory`, `watchHeld`, a
  `waitForLiveSubscriber`), and one `test/helpers/worklets-mock.ts` replaces the seven
  pasted worklets mocks. `test/module/cpu/fixtures.tsx` is removed.
- A hand-built failure reply becomes `transport.failNext(method, error)`. A hand-built
  history page becomes a scenario where one exists. A spy stays only where the test is
  about what the phone asked the host for (the request it sent, how often it polled).
- Coverage is added from existing scenarios for the gap reasons other than `paused`, and
  for `history_unavailable` corrupt and too-new on a module page.
- An assertion on a Reanimated stub's call arguments is replaced by an assertion on what
  the screen shows or what the callback changed (the saved order, the row's label). Where
  jest cannot observe the behaviour at all (easing, duration), the assertion is deleted
  and the behaviour is listed for the simulator check.

The reorder tests still wrap `react-native-reorderable-list` to reach its callbacks; jest
has no gesture system, and the alternative is no drag coverage.

## 7. Smaller items

- One ceiling latch. `useCeiling` in `data/live-stream.ts` and `useRateCeiling` in
  `module/pages/network/history-chart.tsx` are the same `nextCeiling` latch written twice,
  one without the same-tick guard the desktop's `useNiceCeiling` has. They become one
  `useNiceCeiling` in `src/data/nice-ceiling.ts`, and `packages/core/README.md` lists the
  hook as the phone's twin of `src/app/hooks/use-nice-ceiling.ts` (React hooks cannot live
  in core; the math already does).
- `data/hosts.ts` (507 lines) splits: the roster and status queries stay, and the row
  sparkline pipeline (`useHostSparkline` and what it uses) moves to
  `src/data/host-sparkline.ts`, with `sparkline-model.ts` beside it, which removes the
  upward import from `data` into `hosts`. Both stay under `src/data/` because the hook
  reads the transport, and `.claude/rules/mobile/expo.md` keeps data hooks there.
- Dead exports go: `useModuleLiveValues` (`data/history.ts`) and `nativeHandover`
  (`transport/handover.ts`).
- Docs: the structure list in `.claude/rules/mobile/expo.md` loses `src/components` and
  gains `connection`, `handover`, `pairing`, `session`, `settings` and `welcome`;
  `CLAUDE.md` stops naming `src/hooks`. `AGENTS.md` is regenerated.
- Biome: `noFloatingPromises` and `noImportCycles` are turned on repo-wide.
  `noImportCycles` has no findings today; `noFloatingPromises` has one, an unmarked
  `navigate()` in `src/app/hooks/use-open-in-timeline.ts`, which gets the `void` its
  neighbours use.

## Error model

No new failure paths. The refactors keep the existing ones as they are:

- A history read fails as a typed `CommandError`; `HistoryNotice` shows the specific copy
  from `historyReadError` with Retry for `remote_busy`, `remote_unreachable` and `internal`.
- A native startup failure stays in `CoreProvider` state and renders `StartupFailurePanel`.
- `useSelectNativeCore` changes nothing and returns false when the core is not ready; the
  caller's own flow (pairing result, update result) already shows the outcome.
- `Button` reports nothing; `disabled` sets `accessibilityState` and blocks `onPress`.
- A hook called outside its provider throws an `Error` naming the hook and the provider,
  as `usePhoneTransport` does today.

## Risks

- NativeWind 5 and react-native-css are release candidates. The `--spacing-touch` token
  and the single-colour-class rule both depend on how that pipeline compiles; the node test
  in section 2 is the check.
- Jest computes no styles, so the colour fix is verified in the simulator in light and
  dark, on a module chart pin, a history error and a primary button.
- Section 4 moves providers the whole app mounts under. The existing `core-provider`,
  `first-launch`, `app-shell`, `demo` and `reviewer-path` suites pin the behaviour and must
  pass without their assertions changing.

## Out of scope

Merging the three transport providers; a shared `TextInput`; unifying the not-live rules
across module pages; moving static inline styles to classes; the `useColorScheme()` lookups
in widgets; the `after-pair` module singleton; anything in Rust, Swift or the desktop UI.
