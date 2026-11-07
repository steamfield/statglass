# RFC: Shared layers for charts, queries, UI states and Rust collectors

Status: Accepted 2026-11-07, revised after a devil's-advocate review (see "Review outcome"); open
questions decided by the owner. Phase 0 done (2026-11-07, see PROGRESS); phase 1 next.
Date: 2026-11-07.

## Problem

In 0.6.2 every table moved onto one shared TanStack Table layer (`src/app/components/data-table/`).
That work turned up the same code written over and over: sorting five times, hold-on-hover four
times, the sort-state bridge five times. The copies had drifted (see PROGRESS, 2026-11-06).

A follow-up audit of the rest of the codebase found the same shape in four more places. The shared
primitives exist, but routes reassemble them by hand, and the copies drift into visible
inconsistencies and a few real bugs.

The audit was read-only and was checked against the code, first by spot checks and then by the
review. Counts are as of 2026-11-07, `main` at `13a4469`. Implementers re-verify each item before
changing it.

### What is already right

These stay as they are, and the new layers build on them:

- **Charts:** StreamArea, MirrorBars, HeatMatrix and CoreHeatmap, GapBand/GapBands, ChartFrame/ChartGrid,
  `ChartSelectionVeil`, `useTickScroll`, `useNiceCeiling`, `historyTicks`, `ceilingAxis`,
  `useGapBands`, BrushOverlay, ChartTooltipShell, MeterTrack, `useElementSize`, and the single uPlot
  wrapper (`lane-plot.tsx`).
- **Data:** the centralised query keys (`@core/query-keys`), `useRangeQuery`, `probeHistory`,
  `useHeld`, `useModuleSeries`/`useModuleBuckets`, the `select*` + `useShallow` selectors in
  `live-selectors.ts` (including `selectBattery`), `renderWithProviders`, and the shared test
  QueryClient.
- **UI:** `SegmentedControl` (all 18 uses), `SearchField`, `useDismissOutside`, `ui/context-menu`,
  `ConfirmDialog`, `PageHeader`, `SectionCard`, `ModuleCard`, `SettingsPanel`.
- **Rust:** the `Every` cadence helper, `floor_to`/`Tier::bucket_ms`, the shared `find`/`Runs` in the
  detectors, the CLI render helpers, and std's typed `TryLockError` in the agent locks.

## Goals

- Every repeated pattern below gets one owner, and callers express only what differs.
- Fix the drift the copies introduced (listed under each item), and record every user-visible
  change in the behaviour-change table.
- Use the established tool already in the dependency tree before writing anything custom:
  TanStack Query's `queryOptions`/`useMutation`/`setQueryDefaults`, the shadcn primitives,
  `tempfile`.
- Hold the existing gates. No `perf-budget.json` threshold is raised. 1 Hz render paths stay
  render-count stable. The widget import boundary, the `src/core` React ban (`biome.json:112-117`)
  and `crate-edges.json` all stay as they are.

## Non-goals

- **Visual redesign.** Where copies disagree, the design system decides, and it already settles most
  of these cases (cited per item). Nothing new is invented.
- **New features.** A "Show as table" view for module charts is not required by the design system
  (it requires one only for Timeline lanes and container comparisons, `design-system.md:240,257`).
  If wanted, it is a separate proposal.
- **Wire-format changes.** No item touches `statglass-proto`. The R6 items add Rust-published facts
  that do not cross the protocol (see R6).

## Principles

Carried over from the table work:

1. **Layered, and the owner creates.** Shared hooks return models, and shared components render
   them. The owner calls the hook and passes the result down whenever a selection surface, filter or
   pager sits above the body.
2. **`src/core` holds pure logic only.** It has no React and no `@tanstack/react-query`, enforced by
   Biome. Math, formatting, key predicates and ordering live there with unit tests, and widgets may
   import them. Anything that needs React or the query client lives in `src/app/`.
3. **One look per concept**, taken from `design-system.md`, which already specifies most of them.
4. **Rust owns meaning** (`data-boundary.md`). Where a TypeScript copy infers something Rust should
   publish, the fix goes in Rust. Formatting and display stay in the client.
5. **Don't force-fit.** If copies differ for a real reason, they stay separate (architecting-systems:
   "two similar code blocks are better than a wrong abstraction"). Several items below were narrowed
   for exactly this reason.

---

## Workstream C: charts and visualizations

### C1. Module history chart scaffolding (8 cards: 6 brushable, 2 not)

Each card wires up the same pieces:

- `useModuleRange` and the span words
- `useModuleSeries` and `useGapBands`
- for the brushable cards, `useAreaBrush`, `brushScopeProps` and `SelectionSummary`
- `ChartHistoryStatus`
- the StreamArea props
- `historyTicks(seriesRange(...)…)`, which calls `seriesRange` twice

Brushable: cpu `total-card.tsx`, gpu `usage-card.tsx`, memory `pressure-card.tsx`, `swap-card.tsx`
and `used-card.tsx`, power `power-draw-card.tsx`. Not brushable: gpu `power-card.tsx` and
`battery-range-history.tsx`.

Drift to fix:
- **Y axes.** Two axis treatments are used for one kind of chart: ticks in the gutter (cpu, gpu
  usage, pressure, power-draw, gpu power) and gridlines with a corner `ceilingLabel` and no gutter
  (swap, used; `used-card.tsx:112` `inset={0}` follows from this). Decided: gutter ticks everywhere;
  swap and used gain a gutter and drop the corner label.
- **Battery.** It is a 0–100% chart without the percent grid, and its aria label always says
  "selected range".
- **Swap** is brushable but lacks `SelectionSummary`.
- **X ticks.** 5 on most cards, 3 on swap and gpu power.

Owner:
- `useModuleChart(keys, windowMs, module, { brush?, yAxis })` in `src/app/hooks/`. It returns
  `{ series, gaps, brush?, live, span, xTicks, yTicks }` and computes `seriesRange` once.
- A thin `ModuleHistoryChart` in `src/app/components/charts/` (not widgets, because it uses the brush
  store). It renders StreamArea, `ChartHistoryStatus` and `SelectionSummary`.
- The y axis is a declared kind: `percent` or `ceiling(format)`.
- Ceilings keep `useNiceCeiling` with fixed-domain semantics (`design-system.md:232-234`).

### C2. Span wording (12 copies)

`endMs === null ? \`last ${windowWords(w)}\` : "selected dates"` is written out in 12 places.
`container-activity.tsx:102` leaves out "last" because `comparison-canvas.tsx:117` builds "CPU by
container, 1 hour" from it, so that call site gets its own wording.

Owner: `spanWords(windowMs, endMs)` in `@core/live-window`, next to `scopeWords` in `@core/brush`.

### C3. Mirror charts (2 implementations, plus the popover)

`LiveMirrorChart` (`live-mirror-chart.tsx:77-206`) and Disk's `IoPlot` (`disk-io-charts.tsx:36-282`)
duplicate these pieces:
- the up/down label column
- per-side `useNiceCeiling`
- the `rangeSlots` highlight
- BrushOverlay
- the GapBands wrapper
- WindowTicks

Drift to fix:
- Disk builds three `formatHistoryTime` x ticks by hand. They never say "now", which breaks the axis
  rule.
- Disk's brush passes no `selectableToMs` and no `gapExplanationAt`.
- The aria text differs between the two.
- The popover network card (`popover-cards.tsx:389-398`) passes no ceiling, so MirrorBars falls back
  to its per-tick `maxOf` (`mirror-bars.tsx:36-40,62-63`) and the bars rescale every second, against
  the Y-scale rule.

Owner: a presentational `MirrorChart` in `src/app/components/charts/`, used by Network and Disk.

Constraint: Disk's hover is imperative DOM painting, shared by two stacked plots with one tooltip, so
pointer moves don't re-render React (`disk-io-charts.tsx:60-120`). `MirrorChart`'s hover contract
keeps that path and supports one crosshair across sibling plots.

MirrorBars' `upMax`/`downMax` become required. That changes the widget's prop contract, and the
JSON round-trip test in `mirror-bars.test.tsx:16` is updated with it. The popover passes a ceiling
from `useNiceCeiling`.

### C4. Cursor and tooltip (4 implementations)

The four are MirrorHover, Disk's paint, the container comparison chart and the timeline crosshair.
They repeat x-to-slot and x-to-nearest-time lookups (5 copies, one a binary search in
`timeline/_lib/buckets.ts:147`) and use 4 different tooltip side-flip rules.

The design system already fixes the look: "one vertical line synced across all lanes, with a dot on
each series" (`design-system.md:207`), as built in `lane-crosshair.tsx:52-77`. The other three
diverge from it.

Drift to fix:
- **Resolution labels.** The same resolution reads "300 s avg", "5 min avg" or "1 min", and heat
  matrices say "900 second columns".
- **Clocks.** `comparison-chart.tsx:142-147` and `container-history.tsx:146` use locale clocks, which
  `@core/format/clock` deliberately avoids.

Owner:
- `indexAt` and `nearestTime` in `@core/chart-math`.
- `resolutionLabel` moves to `@core/format` and is used everywhere.
- A `useChartCursor` hook, `CrosshairLine` (the `lane-crosshair` look) and a `ChartTooltip` body in
  `src/app/components/charts/`.
- The imperative paint path from C3 stays supported.

### C5. Gap visuals

**Hatch.** The rule is fixed: 1 px stripes at 7 px (`design-system.md:204`). Copies:
- At 7 px: `gap-band.tsx:55`, `battery-history-bars.tsx:15`, `space-map.tsx:27`, `app-table.tsx:75`.
- At 4 px: `heat-matrix.tsx:53`, and the canvas loop in `calendar-heatmap.tsx:117-127`.

Owner: a `bg-gap-hatch` theme utility, plus one canvas-hatch helper. Decided: the 4 px heat-matrix
copy stays as a named dense variant for small cells, added to `design-system.md` beside the 7 px
rule, and the calendar canvas uses the same dense spacing. The
series hatch for ANE (`widgets/lib/accent.ts:59`, `legend.tsx:79`) is a separate encoding and stays
out of this utility.

**GapBand caption.** `lane-overlays.tsx:68-81` re-implements it with different padding, colour and
position. Owner: `GapBand labelPosition="center"`.

**Gap runs.** `container-history.tsx:55-83` re-implements `buildSeriesRuns`
(`@core/chart-math/series-lines.ts`) without the dot and partial handling. A one-bucket run draws
nothing there but a dot in the comparison chart. `sparkPath` in `tray-preview.tsx:160-175` is a third
copy. Owner: generalise `buildSeriesRuns`/`splitGaps` with a contiguity predicate.

**Gap-edge dots.** These are hollow per `design-system.md:204`, and four renderers have drifted from
it. Owner: one `GapEdgeDot` in `src/app/widgets/`, because StreamArea is a widget and widgets can't
import `~/components/**` (`biome.json:316`). A matching uPlot points option goes with it.

**Comparison gap labels.** `comparison-canvas.tsx:100-114` labels bands with the raw reason key. This
depends on R6.1, so it is scheduled with R6 rather than here.

### C6. Ceilings and y ticks outside the shared helpers

Ad hoc ceilings:
- `compact-battery.tsx:48-51`: a raw max, so it rescales every tick.
- MirrorBars' `maxOf` (covered in C3).
- `container-history.tsx:44-54`: a raw max, while the comparison chart fits the same data with
  `fittedCeiling`.

Hand-built y ticks:
- `comparison-canvas.tsx:94-97`: ceiling, half and 0.
- `container-history.tsx:94-97`: ceiling and half, with no 0.
- `battery-history-bars.tsx:40-64`: thirds, with a 30 px gutter.
- `lane-plot.tsx:172-189`: div gridlines.

Owner:
- Live and module-history ceilings use `useNiceCeiling`, keeping the fixed-domain semantics of
  `design-system.md:232-234`.
- `fittedCeiling` is for container comparison and container history only, and `container-history`
  moves onto it (`design-system.md:201`).
- `ceilingAxis(ceiling, format, { zero })` builds the y ticks.

Not changed: Overview scales its system-power bar to the 24 h maximum (`overview/_lib/history.ts:18-21`),
the Power ring to a 10-minute live ceiling, and the Battery ring to battery power. These are
different quantities over different windows, not drift.

### C7. Brush gesture (2 implementations)

`BrushOverlay` (355 lines) and the timeline selection (`use-timeline-selection.ts`, 287 lines) both
implement pointer-capture drag, keyboard arrows and shift-arrows, Escape, snapping, and an ARIA slider.

Their semantics really do differ. The timeline selection navigates and zooms
(`use-timeline-selection.ts:20` `onSelectRange`). BrushOverlay scopes attribution and never replaces
the plotted window (`design-system.md:246`). So only the gesture is shared.

Owner: a `useBrushGesture` hook (drag, keys, snap callback) used by both, and a `useBrush` adapter
that lets bar and canvas charts wire BrushOverlay the way `useAreaBrush` does. That fixes the
missing `selectableToMs`/`gapExplanationAt` in the hand-wired live-mirror, Disk and comparison
charts.

The selected range looks like `ChartSelectionVeil` (`design-system.md:247`, `chart-frame.tsx:92-114`).
MirrorBars' `opacity-35` dimming changes to match it. The drag band (`brush-overlay.tsx:342`) has a
different role and stays.

This is the highest-risk chart item, so it ships in its own phase (3c).

### C8. Smaller chart items

**Chart/legend focus.** There are copies in `power-draw-card.tsx:95-123`, the comparison chart, and
between the space map and its table. Precedence is reversed between them, and dismissal and the
styling constants drift. `design-system.md:251-252` already says pinned rows stay stable while hover
updates their values. Owner: `useSeriesFocus()` returning `{ active, legendItemProps, seriesStyle }`,
with precedence decided by the design system.

**Heat tint.** `cellAlpha` (`timeline/_lib/heatmap.ts:46`) and `core-tiles.tsx:70` (a 10% floor)
duplicate `heatmapAlpha` or drift from it. Fix:
- use `heatmapAlpha` everywhere
- give `HeatScaleLegend` a `stops` prop and use it for the calendar legend
- have `space-map.tsx:28` and `battery-history-bars.tsx:82` use `rampColor`

**Motion tokens read in JS (5 copies).** `space-map` reads `--ease-out` from the element instead of
the root, and doesn't trim it. Owner: `motionMs(name)` and `motionEase(name)` in `src/app/lib/motion/`,
which widgets may import.

**Bar-plus-figure table cells (5).** `ShareCell` appears twice under the same name, plus
`PercentBar`, the cgroup `Bar`, and a hand-built meter in `container-data-row.tsx:316`. Owner:
`MeterCell` in `data-table/data-table-cells.tsx`, with fixed track and figure widths.

**StackBar and ResidencyBar.** They are the same 10 px segmented bar. Owner: StackBar with a colour
per segment, plus `Legend columns={1}`.

**"Show as table" (2 implementations).** The lane dialog and `comparison-values.tsx` differ in
container (dialog vs inline), sort order, gap rows, column layout and clock. Owner: one `ChartTable`
on the data-table layer, used by both. This does not add the view to new charts.

**Remove `BatteryHistoryBars`.** It was superseded by `BatteryRangeHistory` (`battery-range-history.tsx:11`)
and is used only in the gallery. Delete it along with:
- `useBatteryHours` (`use-battery.ts:68-72`)
- `@core/battery-hours`
- `historyKeys.batteryHours` (`query-keys.ts:65`)
- its mock
- the Rust `battery_hours` command

Also update `design-system.md:325,337`.

**Annotation placement (4 strategies).** Owner: move `layoutMarkers` (rows plus "+N", the design
rule) to `@core/chart-math`, and use it everywhere.

**Popover and Overview GPU stream.** These are near-identical (`popover-cards.tsx:229`,
`overview-cards.tsx:154`), and popover GPU lacks the ceiling and window labels that popover CPU has.
Align them through one compact stream card.

**Aria labels (about 18 templates).** Owner: `useChartLabel({ subject, span, now, brushable })` in
`src/app/hooks/`. It quantises the live value to the 10 s edge (`useOpenEdge`), so the label changes
at most every 10 s, as `design-system.md:256` requires. That throttle doesn't exist today, and current
labels change every tick. The render-count tests assert the label's update rate.

---

## Workstream Q: queries, commands and live state

### Q1. Query options and identity

Key reads by position: 13, in 5 hooks (`use-history-series.ts:76-84`, `use-gap-bands.ts:48-54`,
`use-disk-io.ts:48-56`, `use-heatmap.ts:75-76`, `use-disk-space.ts:130-133`). The "hold the previous
answer while its identity is unchanged" placeholder is written about 9 ways, including unconditional
`keepPreviousData` in `use-docker.ts:58`, `use-docker-comparison.ts:26` and `use-events.ts:69`.

Drift to fix: no hold predicate checks the host. `use-heatmap` checks only `key[3]`, and
`range-query.ts:76-77` checks only `meta.rolling`. As a result, `keepPreviousData` and the
narrower predicates show the previous host's data after a host switch. Regression test: switch host
and expect the placeholder to clear.

Owner:
- Keys, plus pure `same*` identity predicates (host included), stay in `@core/query-keys`.
- The `queryOptions(...)` factories, taking `(transport, hostId, …)`, live in `src/app/lib/queries/`
  beside `range-query.ts`. They can't live in core: `queryOptions` exists only in
  `@tanstack/react-query`, which Biome bans from `src/core`.
- The existing `rangeQueryOptions` folds into this module.
- One `holdWhile(same)` placeholder replaces the variants.
- `use-disk-io` moves onto `useRangeQuery`, which removes its copy of the open-edge freshness rule and
  its literal `10_000`.

### Q2. Key hygiene

- **`appKeys.updates`.** It is dead (the update check isn't a query, `update-row.tsx:56`). Delete it,
  along with its `settingsInvalidation` branch.
- **`appKeys.appearance`.** It is unused, while appearance is fetched by hand twice (`app.tsx:78-91`,
  `use-window-appearance.ts:40-54`). Use it for a query with `staleTime: Infinity`, kept current by
  `setQueryData` from the event, and keep the `lowPower = false` fallback on error.
- **History keys.** Build every one from `historyKeys.host`. `dockerKeys` takes the host first.

### Q3. Error typing and retry

**Error type.** Two casts to `CommandFailure` (`use-heatmap.ts:89`, `use-timeline-data.ts:268`).
Registering `CommandFailure` as the global `defaultError` would be wrong: rejected IPC calls and
`select` throws arrive as other `Error`s, which `shouldRetry` (`query.tsx:30-36`) and `remoteQueryText`
already handle separately. The default stays `Error`, and the casts become an `asCommandFailure(error)`
narrowing helper in `@core`.

**Retry.** `retry: false` is set per query in 12 places, and those are per-family policies: polled
disk scans, the public-IP lookup, and cleanup polling. v5's `retry` callback never receives the query,
so `shouldRetry` stays based on the error kind. Family policy goes into the Q1 factories, or into
`queryClient.setQueryDefaults(family, { retry: false })` in `makeQueryClient`.

**Intervals.** The repeated poll and stale literals (`30_000`, `60_000`) get names in one place.

### Q4. One-shot commands

The bugs here are narrower than first thought. Most command sites already settle state in
try/catch/finally. The confirmed issues:
- `use-reset-history.ts:23-25` leaves `resetting` stuck when the IPC call rejects.
- `use-write-settings.ts:16` has no rejection handler.
- `CommandError` is turned into text 5 ways, with fallbacks of the raw `kind`, "Please try again.",
  `kind.replaceAll("_"," ")` and `String(error)`.

Owner:
- `commandErrorText(error, fallback)` in `@core`. The existing `remoteErrorText`, `settingsErrorText`
  and `remoteQueryText` become thin uses of it.
- `useCommandMutation(fn, { errorText, invalidate, onSuccess })` over `useMutation` and `unwrap`, used
  only by one-shot "command, then invalidate, then toast" sites: reset history, `update-row.tsx`,
  `engine-chooser.tsx`, `command-line-panel.tsx`, and any others that match exactly.

Kept as they are, apart from switching to `commandErrorText`:
- `use-add-host-connection` is a multi-phase state machine with attempt tokens.
- `container-actions` hands off to a polled operation.
- `useWriteSettings` goes through the Rust-owned settings mirror; it gains a rejection handler.

Regression test: a rejected reset settles `resetting`.

### Q5. Subscriptions

`use-docker.ts:16-42` and `container-logs.tsx:30-64` are near-verbatim channel subscriptions. Owner:
`useDockerSubscription(open, onBatch)`. The appearance fetch effects are handled in Q2.

### Q6. Time windows

Copies:
- About 14 inline `Math.floor(x / w) * w`, alongside two `floorTo` definitions.
- `useOpenEdge` takes only the 10 s step, so other widths re-implement it (`use-history-series.ts:30-34`,
  `use-timeline-data.ts:136-138`).
- Four preset tables (`CHART_WINDOW_MS`, `RANGE_PRESETS`, `DOCKER_RANGES`, `SPAN_MS`).
- Five copies of the `{absolute: {from_ms: end - d, to_ms: end}}` constructor, plus 47 raw
  `3_600_000`/`86_400_000` literals.
- 21 copies of `useModuleRange()?.endMs ?? null` and 6 of `useHost(s => gridIntervalMs(s.status))`.
- The "beyond retained per-app usage" test, decided in 7 places in two forms.

Owner:
- `@core/time-grid`: `floorTo`, `ceilTo`, `MINUTE_MS`, `HOUR_MS` and `DAY_MS`.
- `useOpenEdge(step)`.
- One preset table and `windowEnding(endMs, durationMs)` in `@core/chart-range`, built on the
  generated constants from R6.2/R6.3, which land first.
- `useModuleEnd()` and `useGridInterval()`.
- `useUsageHistorical(windowMs)`.

### Q7. Live selectors and series keys

Copies:
- `held(s, k)` is defined twice, plus about 17 inline `s.held[k] ?? null`.
- `keysOf` is defined twice, plus 4 inline `s.layouts[s.layoutNo]`.
- Display-key labels are parsed 3 ways.
- About 10 series keys are built from template strings instead of `sk()`, which breaks silently
  once a key has more than one label.
- The battery summary is selected 3 ways, and boot-volume capacity 2 ways.

Owner:
- Export `held` and `keysOf` (`live-selectors.ts:17,20`).
- `parseLabels` in `@core/series-key`.
- Every key goes through `sk()`.
- `use-battery` and `live-machine-header` compose the existing `selectBattery`.

### Q8. Numbers, units and formatting (helpers only in phase 1)

- **Null-propagating arithmetic (7 copies).** Becomes `sumOrNull`/`scaleOrNull` in
  `@core/chart-math/numeric.ts`.
- **Unit settings.** They are mapped to formatter units 4 times, and the default before settings
  load drifts between °F and °C. Owner: `displayUnits(settings | null)` in `@core/format` with one
  default, °F (decided; matches `useUnits` and the tray today, so only Timeline lanes change),
  wrapped by `useUnits`.
- **Local formatters that bypass `@core/format`:**
  - `wh`, and `(used/div).toFixed(1)`
  - about 10 `${Math.round(v)}%`
  - signed and "pp" deltas, 2 copies each
  - `compactRate`
  - CSS-percent strings

  Owner: `formatSignedDelta`, `formatPercentPoints` and a CSS-percent helper.
- **Missing and date values.** About 28 literal `"—"` where `MISSING` exists; 19 inline `toLocale*`
  calls. Owner: `formatDateTime` in `@core/format/clock`.
- **Rollout.** Phase 1 ships the helpers and their tests only. Each later phase migrates the call
  sites in the files it owns, which keeps phase 1 from touching every route.

### Q9. Mock transport

- `ok` is redefined 5 times even though `mock/protocol.ts` exports it. There are also local error
  constructors and inline error literals.
- The range checks duplicate `checks.range` in 5 places, and the copies disagree on whether an empty
  range is valid.
- The remote-forward preamble is written 9 times.
- The Rust history-merge bucket math is re-derived 3 times.
- The seed derivation drifted, between two `fnv1a` ranges and a char-code sum.

Owner: shared `ok`/`fail`, a `checks.range` with R3's rule (answered below), a `forward(host, fn)`
helper, `mockBuckets(...)` and `seedOf(s)`.

### Q10. Test builders

- Inline live-frame pushes in 12 test files, 4 of which first push a custom layout.
- 4 `LiveProcess` factories with drifted defaults.
- 2 copies each of the `NetworkByApp` and status builders.

Owner: `tests/live-frames.ts` (`pushLayout`, `nextFrame(state, overrides)`) and
`tests/fixtures/processes.ts` (`liveProcess(over)`).

---

## Workstream U: UI states and components

### U1. Status, error and loading lines (about 35 copies)

Copies:
- `<p role="status" className="text-[12px] text-muted-foreground">`
- `<p role="alert" className="text-[12px] text-destructive">`
- lines with no role at all

Drift to fix:
- sizes of 11, 12 and 13 px
- missing roles
- `role="alert"` on muted informational text: `containers/detail-route.tsx:151,163`,
  `docker-surfaces.tsx:182,192`, `container-activity.tsx:121`, `container-results.tsx:87`,
  `timeline/route.tsx:305`
- raw `String(error)` and `.message`, which `commandErrorText` (Q4) replaces

Owner: `InlineMessage tone="status|error|note"`, and `QueryNotice({ query, loading, error, empty })`
for the pending → error → empty sequence. `AppsNote` (`app-table.tsx:57`) becomes a use of it.

### U2. Full-width table rows (10 copies)

Empty and footnote rows are built by hand. Some colSpans are hard-coded (`apps-now-card.tsx` 2,
`apps-card.tsx` 6), and padding and hover styles drift. Owner: `DataTable` builds these rows from
plain `empty`/`footnote` content, using the colSpan it already computes. `FullWidthRow` is exported
for bodies that render their own rows.

### U3. Pausing row order (7 copies)

`useDataTable` owns the hold, but every caller builds `paused` itself, and four ignore keyboard focus:
process, interface, apps and cgroup.

Owner:
- `useDataTable` returns `holdProps` covering pointer plus focus.
- It accepts extra conditions, because containers also hold on `contextOpen`/`pendingIds`
  (`container-table.tsx:123`) and process-table's hover hold is opt-in (`:438`).
- `ProcessSelectionSurface` uses the same hook.

Decided: the hold counts keyboard focus only (`:focus-visible` inside the table), plus the pointer.
Disk processes and containers hold on any focus today, so a mouse click there will no longer freeze
order after the pointer leaves.

### U4. Table-layer leftovers

- **UsageAppsCard** keeps its own hold-order code (`usage-apps-card.tsx:216-228`) and re-sorts by
  selection order twice. It moves onto `useDataTable` + `hold` for its top level.
- **The container table** runs its own virtualizer beside `useDataTable` (`container-table.tsx:152`)
  because of its group rows. Decided: use TanStack Table's grouping feature (`columnGroupingFeature`,
  `createGroupedRowModel`, `createExpandedRowModel`) with project as the grouped column, so group rows
  come from the table model and `DataTable`'s `virtual` body renders grouped and leaf rows alike.
  Collapse state maps to TanStack's `expanded` state, keeping the `?collapsed=` URL param. No
  aggregation functions are registered; group rows show the count only, as today. Sorting stays
  within groups, and the group order follows the current sort's first member, as today
  (`container-table.tsx:104-106`). Verify the docker-128 `e2e-perf` budget holds with the grouped
  row model.
- **apps-now-card** sorts and slices by hand before `useDataTable` sorts again. It passes its top-N
  straight to `manualSorting`.

### U5. URL search params (13 copies)

There are three named setters and about ten inline patches. The range is written into `from`/`to` by
hand.

This is a consistency cleanup, not a bug fix. React Router's functional `setSearchParams` doesn't
queue: same-tick calls don't build on each other (`react-router` `lib/dom/lib.d.ts:1490-1494`). The
cited setters also run in separate ticks.

Owner: `useSearchParamPatch()` returning `patch({ k: v | null }, opts)`, with one rule for `replace`
and the page reset. `writeRange`/`readRange` sit beside `diskRange`.

### U6. Confirmation dialogs

`hosts/route.tsx:102-110`, `host-agent-actions.tsx:51-74` and `update-all-dialog.tsx:65-121`
re-implement lock-while-busy on a plain `Dialog`. They close on an outside click and are not
`alertdialog`.

Owner: `ConfirmDialog` with an `items` review-list slot. The review list is written 3 times.

`docker-cleanup-flow.tsx` is a two-step wizard, so it stays a `Dialog`, and gets the alertdialog role
and outside-click lock only.

### U7. Page scaffolding

- **Titles.** Settings, overview, timeline and pending bypass `PageHeader`. Timeline needs a
  focusable heading ref, and Overview a `StatusPill` in the actions.
- **Module routes.** Six repeat the same frame: `ChartRangeProvider` → stack → `PageHeader` +
  `WindowControl` → `ChartRangeNotice` → `windowMs !== null && …`.
- **Timeline's range control.** It hand-rolls previous / next / Live, although `HistoryRangeControl`
  documents itself as serving Timeline.

Owner: `PageHeader` gains `headingRef`, a `ModulePage` shell, and `disabled`/`pending` on
`HistoryRangeControl`.

### U8. Popovers and menus

Raw Radix Popover and DropdownMenu are used in 4 places with drifting content styles:
`window-control.tsx`, `annotation-row.tsx`, `popover-options.tsx`, `container-filters.tsx`.
`container-filters` uses a literal "✓ " instead of an item indicator.

Owner: shadcn `ui/popover` and `ui/dropdown-menu`, matching `ui/context-menu`.

### U9. Card shells

- `heatmap-card.tsx` builds a raw Card header with a subtitle.
- `docker-surfaces.tsx:63-98` has a hand-built expanded popover card.
- `engine-chooser.tsx:63-67` builds a card from `rounded-card border bg-card p-4`.
- `menu-bar-panel.tsx:176-195` inlines `SettingsPanel`, because it needs an un-clipped sticky preview.
- `container-table.tsx:237` uses a raw title.

Owner: a `subtitle` prop on `SectionCard`, an `overflow` option on `SettingsPanel`, and `ModuleCard`
for both Docker variants.

### U10. Module metadata

Six tables hold module name, accent, description and absence wording. The absence wording is
hard-coded to "this Mac" in `modules-panel.tsx:29-32` and `module-toggle-list.tsx:56`, which ignores
the remote host noun and edition state. The module row is also built twice.

Owner: one `MODULE_META` beside `widgets/lib/accent`. `unavailableText` is the only source of absence
wording. One `ModuleToggleRow`.

### U11. Small hooks and helpers

- **Copy to clipboard (5 copies).** Only `CopyValue` resets its "Copied" state. Owner:
  `useCopyToClipboard()`.
- **Can this view send quit signals? (4 copies).** Owner: `useCanSignal()`.
- **Text search predicates (4).** Disk processes disagree with Processes on PID-prefix and port
  matching. Owner: `matchProcessQuery` for processes, plus one `matchText(query, …fields)`.
- **Top-N ranking outside `topProcesses` (5).** Nulls are handled three ways. Owner:
  `topBy(rows, value, n)` in `@core`, which drops gaps.
- **8 px swatch (6 copies).** Use `Legend`'s `Swatch`.
- **KPI strips.** `StatStrip` and `StatGrid` are near-identical, and five KPI blocks bypass both.
  Owner: one stat-list widget.
- **Dashed "Other" chip (2 copies).** It goes beside `OtherAppsRow`.

---

## Workstream R: Rust

### R0. Agent test flake (fix first)

The test is `update_reconnect::transaction::tests::rollback_restores_units_…`, which failed CI on
`dba6598`.

Cause:
- `crates/statglass-agent/tests/support/update_reconnect.rs:6-8` includes production
  `src/update/transaction.rs` by `#[path]`.
- `cfg(test)` is also true for integration builds, so the transaction unit tests (already in
  `transaction/tests.rs`) compile into the `pipe` binary.
- The sibling tests in that binary fork children while the non-blocking flock fd is open. A child
  holds a duplicate of the open file description until it execs.

`maintenance.rs:68-77` already works around this with a self re-exec.

Fix:
- Stop including production source by `#[path]`. The integration test needs only
  `begin`/`prepare`/`directory`/`recover` (`update_reconnect.rs:123-157`), so expose those through the
  crate, or move the `mod tests` declaration to `update/mod.rs`.
- Extract the re-exec into a helper that computes the test path at runtime, because maintenance
  hard-codes `"maintenance::tests::…"`.
- The failure was on Linux CI, so the proof is a 50-run loop on Linux: Docker via `ensure-docker`,
  or hosted Linux CI.

### R1. File locks

The store lock uses rustix `flock`. The agent uses std `File::try_lock`, which already returns a typed
`TryLockError::{WouldBlock, Error}`. `history_lock` reuses store's `lock_path`/`open_private`, and
`maintenance::lock` is an installation lock unrelated to the store.

Owner: make `WriterLock::acquire` public as the agent's history-lock entry point. Match on
`TryLockError` in `maintenance.rs:26` and `transaction.rs:219-226`, so that I/O errors stop reading as
"collector still owns history". No new wait variant.

### R2. Counter and rate dedupe in collectors

Duplicates:
- `PartSum` (`macos/mod.rs:50-74`, `linux/counters.rs:3-24`)
- `span_secs` (1 helper, about 9 inline copies)
- `rate` (2)
- `counter_rates` (2)
- `span_ms` (3)
- the network emit loop (2, about 60 lines each) and `MAX_PLAUSIBLE_BPS` (2)
- the I/O metric list, which has three copies: `macos/disk.rs:26`, `linux/diskstats.rs:32`, and
  `statglass-store/src/disk_io.rs:9` `DISK_IO_METRICS`

Not drift:
- `macos/cpu.rs:153` `wrapping_sub` on u32 tick counters is correct wrap handling.
- `macos/disk.rs:280` returning 0.0 has no effect, because `rate` returns None when `secs <= 0`.
- Process collectors key by `(pid, start_time)`, and macOS swap counters are monotonic since boot, so
  their `saturating_sub` never sees a reset in practice.
- The two `counter_rates` differ in time unit for a real reason: macOS measures in nanoseconds,
  Linux in milliseconds.

Owner: a crate-root `statglass-collect/src/counters.rs` with no cfg gate. It holds `PartSum`,
`span_secs`, `rate`, `counter_rates` with a unit parameter, and one wrap-aware `counter_delta`. One
network emit function serves both platforms. The metric list moves to `statglass_schema::disk_io`, and
the store uses it.

There is no user-visible behaviour change. Tests cover a wrap.

### R3. Time-range validation (about 14 copies)

About 10 sites reject `from == to`:
- `ipc.rs:17,119`, `query/top.rs:80`, `query/history.rs:43`, `history/queries.rs:54`
- `durable_usage.rs:198`
- the three `statglass-engine` docker persistence modules
- `cli/query.rs:196`

Two accept it: `usage.rs:172` and `history/queries.rs:248`. `store/reader.rs:210,641` returns an empty
result. Maximum spans are given in days in some sites and milliseconds in others, and there are four
error texts.

Owner: `TimeRange::new(from, to, max)` in `statglass-schema`. It rejects an empty range. Its
`RangeError` maps once into `CommandError::InvalidArgument`. It is kept out of specta, because TS
already has a different `TimeRange` in `@core/brush`. The store keeps returning empty.

Behaviour change: the two commands that accepted empty ranges now reject them.

### R4. Shell and store helpers

- **Local-vs-remote dispatch (12 copies).** In `disk_space.rs` (8), `durable_usage.rs` (2) and
  `commands.rs` (1). Unknown-host handling drifts. Owner: `AppState::route(host)` returning
  `Local | Remote`.
- **JoinError → CommandError (7 copies).** The messages drift. Owner: make `commands::spawn_blocking`
  `pub(crate)` with one message.
- **`StoreError` busy/corrupt classification (3 copies).** The remote copy misses `Locked` and the
  corruption checks. Owner: `StoreError::is_busy` and `StoreError::is_corrupt` on the type.
- **Bucket flooring.** 14 inline `div_euclid(w) * w` sites; use `floor_to` and `Tier::bucket_ms`.
- **Tier → table match (4 copies).** One lookup in `statglass-store`.
- **SSH exec wrappers (3).** `run_remote` treats any non-zero exit as an SSH or auth failure, while
  `Ssh::exec` correctly treats only 255 that way. Owner: rebuild `run_remote` and the installer on
  `Ssh::exec`, and bound the installer's stderr.

### R5. Rust test infrastructure

- `HostRecord`/`HostInfo` literals (about 20 copies): dedupe within each crate's existing test
  support. A shared fixture in `statglass-schema` would need dev edges that `crate-edges.json`
  forbids, and widening the policy needs a decision entry first.
- 8 leaked temp dirs move to `tempfile`.
- About 20 poll-until loops are replaced with one `eventually(what, timeout, f)` per crate. Retire
  the flake-prone 30×1 ms loops.

### R6. Facts the client infers that Rust should publish

None of these touches `statglass-proto` or the wire format, and none needs a migration.

1. **Docker coverage kind and label.** Rust derives a `kind` and `label` on `DockerCoverage` from the
   persisted `reason` (`store/docker/mod.rs:209`). This replaces the hard-coded reason keys in
   `history-details.tsx:9-20` and the raw-key gap labels in `comparison-canvas.tsx:100-114`.
   - Rust also makes its points consistent with coverage, which removes the client rewrite to
     `measured_ms: 0` (`comparison-chart.tsx:103-112`).
   - Confirm which coverage flag applies to rate metrics (`container-history.tsx:63`).
   - Phase 5. It is a schema type change, so it gets a decision entry.
2. **Docker bucket width.** Publish it as a generated constant, like `NET_BUCKET_MS`. TS hard-codes
   `10_000` in 5 places. This is additive with no decision entry, and moves to phase 1.
3. **Chart window durations.** Generate `DEFAULT_CHART_WINDOW` and the ChartWindow durations
   (`live-window.ts:41-43`) from Rust's enum. This is additive, and moves to phase 1 so Q6's preset
   table is built on it once.
4. **Tray preview strings (downgraded).** Formatting belongs to the client. Instead of Rust
   publishing strings, Rust generates a golden table of `rate_line`/`rate_text` outputs, and a TS test
   asserts `tray-layout.ts` against it. `disk_used_pct` stays computed in TS from published values,
   because a stored series would grow the rows that the `engine.store` gate measures.
5. **Overview gaps and peak.** Use a gaps/last-wake query instead of probing `cpu.total` with
   `max_points: 1`, and use `query_series_stats` for `useMax24h`. This is Rust-local.

---

## Delivery

### Pre-step

`codex/ux-native-popover`, `codex/ux-timeline` and `codex/ux-usage-history` are not merged into
`main`. They are 11 to 20 commits ahead, and they touch `brush-overlay.tsx`, `area-brush.tsx`,
`battery-range-history.tsx` and `historical-usage-*`. PROGRESS records their work as landed, so they
were probably merged by other means. Confirm this, then delete them before phase 3.

### Order and dependencies

| Phase | Work | Depends on | Notes |
|---|---|---|---|
| 0 | R0 flake | none | Unblocks reliable CI |
| 1 | Core helpers and tests only: Q6, Q7, Q8 helpers, Q10; R6.2 and R6.3 generated constants | none | No route call sites change in this phase |
| 2a | Q1–Q5, Q9, U1, U2 | 1 | Q9's range rule is settled by R3's answer above |
| 2b | R1–R5 | 0 | Independent of the frontend |
| 3a | C1, C2, C6 | 1, 2a (`QueryNotice`) | Migrates Q8 call sites in its files |
| 3b | C3, C5 (except the comparison labels) | 3a | Needs the imperative-hover constraint |
| 3c | C4, C7 | 3b | Highest risk; gesture only |
| 3d | C8 | 3c | |
| 4 | U3–U11 | 2a, and strictly after 2a for `data-table/*` | Migrates Q8 call sites in its files |
| 5 | R6.1, R6.4, R6.5 and the C5 comparison labels | 2b | R6.1 decision entry first |

2a and 2b run in parallel. Within a phase, runs are cut by file ownership, as in the table work, and
each shared file is owned by exactly one run.

### Execution method

Each phase runs through `ce:executing-plans`. `ce:architecting-systems` applies to every new shared
module.

Implementation is delegated through foreman to Codex sol agents with written contracts. For each
run, the orchestrator reviews the diff, runs the gate, commits on the plan branch and merges
locally. `ce:code-reviewer` runs on each phase's full diff, and every finding is fixed.

Phase notes go in `plan/PROGRESS.md`, and behaviour changes go in the table below and in the
CHANGELOG when a phase ships.

### Verification

Every phase:
- `bun run check`
- `make check`, run from the main checkout: inside a nested worktree, cargo treats the parent repo as
  the workspace for `vendor/tauri-plugin-updater`
- `bun run test:e2e`
- `make e2e-perf`
- no `perf-budget.json` threshold raised

Chart and UI phases:
- Screenshots of every touched screen in both themes, compared against `plan/design-system.md`, plus
  the dev gallery. Every remaining difference is named.
- Profiler render-count tests for `ModuleHistoryChart` and `MirrorChart` (one commit per pushed
  frame, revert-verified), and a test that `useChartLabel` changes at most every 10 s.
- The e2e-perf gate covers cpu1h, gpu1h, power1h and containers. The ungated pages (Processes, the
  other module pages) are measured with `make bench` and reported as advisory numbers.

Rust phases:
- `make rust-linux-check` and `make architecture-check`.
- A wrap test for `counter_delta`.
- The R0 50-run loop on Linux.

Each behavioural fix gets a regression test that fails before the fix:
- the placeholder clears on a host switch (Q1)
- reset history settles on a rejected call (Q4)
- keyboard focus holds row order (U3)
- empty-range rejection (R3)
- the popover network ceiling is stable across ticks (C3)

### Behaviour changes (each gets a changelog line)

| Item | Change |
|---|---|
| C1 | Module history charts share one y-axis treatment and x tick count. The battery chart gains a percent grid and a live label. Swap gains a selection summary. |
| C2 | Chart labels share one span wording. |
| C3 | Popover network bars stop rescaling every second. Disk I/O x ticks say "now" and follow the axis rule. |
| C4 | One crosshair look on every chart. Resolution labels read the same everywhere ("5 min avg"). Container clocks stop following locale. |
| C5 | Heat-matrix hatch stays 4 px as a documented dense variant; the calendar canvas matches it. A one-bucket run in container history draws a dot. |
| C7 | The selected range in mirror bars uses the shared veil. |
| C8 | Aria labels change at most every 10 s. The battery hours view and the `battery_hours` command are removed. |
| Q1 | Switching hosts no longer shows the previous host's chart data while loading. |
| Q4 | A failed history reset no longer leaves the button stuck. |
| Q8 | Timeline lanes default to °F before settings load, like the rest of the app. |
| U1 | Informational lines stop announcing as alerts. |
| U3 | Keyboard focus holds row order on Processes, Network apps, Interfaces and cgroups. Disk processes and Containers stop holding order after a mouse click once the pointer leaves. |
| U4 | Container project groups come from TanStack grouping; markup, collapse and `?collapsed=` are unchanged. |
| U6 | Host and update confirmations no longer close on an outside click. |
| U10 | Module absence text names the actual host instead of "this Mac". |
| R3 | Two history commands start rejecting empty ranges. |

### Size

The duplication covers roughly 2,500 to 3,500 lines across about 150 files, and the work should
net-delete code. The phases are each at most the size of the table migration. Phase 3 is split into
four for that reason.

## Risks

- **Visual churn on chart pages.** Mitigation: the design system decides each conflict, before/after
  screenshots are taken per page, and the gallery is updated in the same run.
- **1 Hz cost of the new hooks (C1, C3, C4).** Mitigation: models are memoized on stable keys, the
  Profiler tests above, the e2e-perf gates, and advisory bench numbers for ungated pages.
- **C7's two gesture systems.** Mitigation: share only the gesture and keep the semantics. It gets its
  own phase (3c).
- **Stale `codex/ux-*` branches.** Mitigation: the pre-step.

## Open questions

None remain. Decided by the owner on 2026-11-07:

- **Y-axis treatment (C1).** Gutter ticks everywhere.
- **Heat-matrix hatch (C5).** 4 px stays as a documented dense variant.
- **Container grouping (U4).** TanStack grouping.
- **Temperature unit default (Q8).** °F.
- **Hold focus scope (U3).** Keyboard focus only (`:focus-visible`).

Answered during review:
- **Empty ranges (R3).** Rejected, except at the store, which returns empty.
- **`BatteryHistoryBars` (C8).** Removed, along with its Rust command.
- **Chart/legend focus precedence (C8).** The design system already decides it
  (`design-system.md:251-252`).
- **System power denominator (C6).** Not drift. The three rings and bars scale different quantities
  over different windows.

## Review outcome

A `ce:devils-advocate` pass (2026-11-07) checked the RFC against the code. Findings that held up and
were applied:

- **Q1.** `queryOptions` factories moved out of `src/core`, which Biome bans and where query-core has
  no `queryOptions`. The missing host check in hold predicates was added as drift.
- **Q3.** Dropped the global `defaultError: CommandFailure`, which would have been a false type for
  rejected IPC calls. Moved retry policy to `setQueryDefaults` and factories, because v5's retry
  callback can't see the query.
- **Q4.** Narrowed. Most sites already settle in `finally`. The confirmed bugs are reset history and
  write settings. Multi-phase flows stay as they are.
- **U5.** The lost-update bug was wrong (React Router doesn't queue functional updates). It is now a
  consistency cleanup only.
- **C8.** Module "Show as table" was moved out of scope, because it's a new feature.
- **C6.** History ceilings keep `useNiceCeiling` and fixed domains per the design system.
  `fittedCeiling` is for containers only.
- **C8 aria labels.** These now quantise to 10 s, per the design system.
- **R5.** The shared schema fixtures were dropped, because they need forbidden dev edges.
- **R0.** The fix now removes the `#[path]` include and runs the 50-run proof on Linux.
- **R1.** Uses std's typed `TryLockError`.
- **R2.** Recast as a dedupe. The reset drift claims didn't hold. The third I/O metric copy was added.
- **R3.** The empty-range counts were corrected.
- **C4, C7.** The crosshair and selection looks were already decided by the design system. Only the
  brush gesture is shared, because the semantics differ.
- **C1.** Corrected to 6 brushable and 2 non-brushable cards.
- **C5.** The comparison labels were moved to phase 5, behind R6.1.
- **Q7.** `selectBattery` was already exported.
- **R6.** Wire-format status settled. R6.2 and R6.3 moved to phase 1, and R6.4 was downgraded.
- **Phasing.** Phase 3 split into four sub-phases, and Q8 phase 1 is now helpers only.
- **Behaviour changes.** Added the behaviour-change table and the branch pre-step.

One finding was corrected rather than applied: the `codex/ux-*` branches are not merged into `main`
(`git branch --merged`), so they stay a pre-step instead of being dropped.
