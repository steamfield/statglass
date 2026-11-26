# @statglass/core

Platform-free client code shared by the desktop app (repo root) and the iPhone app
(`apps/mobile`): formatters, chart math, live and history state, host clock, series keys,
query keys, remote-error copy, the mock transport and its fixtures, and the generated types.

Both apps import it as raw TypeScript through the `@core/*` alias
(`@core/*` -> `packages/core/src/*`); directory imports such as `@core/format` resolve to
`index.ts`. There is no package export map. `package.json` declares core's own dependencies and
its workspace membership.

## What is shared

Share a thing when both apps would change it for the same reason. Keep it per app when they
would change it for different reasons. A shared module that needs a platform flag to decide
has failed that test and is forked (see below). Background: `plan/rfc-ios-app.md` section 4.6.

## Guards

1. **Pull, never push.** Code moves into core in the same change that adds its second consumer.
   No bulk moves of `src/app/hooks` or `src/app/widgets`; a widget the phone never renders keeps
   its logic in the desktop app.
2. **No platform code.** `packages/core/src` imports no `react`, `react-dom`, `react-native`,
   `expo`, `expo-*`, `@tauri-apps/*`, `@steamfield/ui` or `@desktop/*`, and does not use the
   `window`, `document` or `navigator` globals (tests running under happy-dom are exempt from
   the globals rule). Biome enforces this (`biome.json` overrides for `packages/core/**`), with
   fixtures in `scripts/architecture/test_biome_rules.py`. Models take measurable inputs, never a
   platform enum. Annotation caption scale is measurable like plot width because Dynamic Type
   changes how much room the text needs, and either app can pass that scale to the same layout.
3. **Fork instead of flagging.** When a shared model needs an option only one app uses, that app
   copies the model and the copy is listed under "Forks" below.
4. **Tested once, rendered twice.** Model tests assert view models from the shared fixtures; each
   app's gallery renders the same fixtures. Pixel comparison stays within each app.
5. **Both apps check every shared change.** A change under `packages/` runs the desktop and
   mobile typecheck and tests.
6. **The desktop's performance gates hold.** Extracting a model is a pure refactor: render-count
   tests, `e2e-perf` and the idle-CPU budget stay green, and models stay pure and
   allocation-light on the 1 Hz path.
7. **Each app pins its own React**, so neither forces the other's React upgrades.

## Generated code

`src/generated/types.ts` holds every type and constant tauri-specta generates from the Rust
side, with no Tauri import. The Tauri `commands` and `events` it generates alongside live in the
desktop app at `src/desktop-transport/commands.ts`. Both are written by `make bindings` and never
edited by hand; `make bindings-check` fails when either is stale.

The desktop's Tauri adapters (`native*.ts`, `app-transport.ts`) live in
`src/desktop-transport/` and are imported as `@desktop/*`.

## Forks

- [The phone's `useNiceCeiling`](../../apps/mobile/src/data/nice-ceiling.ts) is the twin of [the desktop hook](../../src/app/hooks/use-nice-ceiling.ts).
- [Gap bands](src/widget-models/gap-band.ts) share clipping and geometry. The
  [iPhone renderer](../../apps/mobile/src/widgets/gap-bands.tsx) estimates caption
  widths and moves colliding captions below the plot because narrow plots at large
  Dynamic Type sizes can leave too little room for both labels.
- The [Power card model](src/popover/cards/power.ts) is shared. The
  [iPhone card](../../apps/mobile/src/cards/power-card.tsx) lists only the rails the
  host reported (a measured zero stays), where the desktop keeps the full rail legend,
  because a phone-width card with a column of dashes buries the readings it has.
- The [Memory card model](src/popover/cards/memory.ts) is shared. The
  [iPhone card](../../apps/mobile/src/cards/memory-card.tsx) draws a one-column
  legend with Swap last on a hatched swatch, where the desktop uses two columns,
  because two columns of label and value truncate at phone width and large Dynamic Type.
