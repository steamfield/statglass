---
name: widget-model
description: Extract one StatGlass widget's geometry and state logic into a pure model in packages/core and build its React Native twin for the iPhone app, without changing the desktop widget. Use when the phone needs to render a widget the desktop already has (StreamArea, RingGauge, InlineBar, CoreTiles, HeatMatrix and the rest), or when a shared widget model needs to change.
---

# Widget model

A widget the phone renders splits into a model in `@statglass/core` and one thin renderer
per platform (RFC `plan/rfc-ios-app.md` 4.6). The model is the decision about what the
widget shows; the renderers only draw it. Rules: `.claude/rules/shared-packages.md`.

Do one widget per change. Extract a widget only in the change that adds its phone twin
(pull, never push).

## 1. Read the desktop widget

Open the widget in `src/app/widgets/` and its props type. Mark what is model and what is
rendering:

- Model: geometry (paths, bar extents, tick positions, gap bands), state logic (which value
  is the headline, thresholds, empty and gap states), final strings (formatted values,
  units, accessibility labels and value text), and color choices as token names.
- Rendering: elements, CSS classes, motion, hover and pointer handling, refs and measured
  sizes.

If the logic needs a platform answer ("on the phone, show fewer ticks"), make it a
measurable input (width, density), never a platform enum. If one platform truly needs a
different rule, fork: copy the model for that platform and list the copy in
`packages/core/README.md`.

## 2. Write the model

Create `packages/core/src/widget-models/<name>.ts`:

- `export function <name>Model(props: <Widget>Props, input: { width: number; density: ... }): <Name>View`
- Pure and synchronous. No React, DOM, React Native, `window` or `Date.now()`; time comes
  in through props.
- Allocation-light: it runs at 1 Hz in the popover. Reuse what the desktop component already
  computed instead of adding sorts, maps or closures per tick.
- The view model holds token names (`"accent-cpu"`, `"status-warning"`), not hex values;
  each renderer resolves tokens its own way.

## 3. Test the model from shared fixtures

Write `packages/core/src/widget-models/<name>.test.ts` against the fixtures both galleries
use (the widget `sample-props` and the mock scenarios). Assert whole view models: geometry,
strings, token names, the gap and not-available cases, and the boundaries (zero, full,
one sample, a gap at the edge). Watch each test fail once by breaking the model.

Run: `bun run test -- packages/core/src/widget-models/<name>`.

## 4. Point the desktop widget at the model

Change the desktop component to call the model and render its output. Keep its name, file
and props exactly, so no route changes. This is a pure refactor: the existing widget tests
must pass unchanged.

Check: `bun run check`, the render-count tests, `make e2e-perf`, and gallery screenshots at
`/?route=/dev/gallery` in both themes compared with main. Any pixel change is a bug in the
extraction.

## 5. Build the native twin

Create `apps/mobile/src/widgets/<name>.tsx` taking the same props type. It calls the model
and draws the view with `react-native-svg` or views, resolving token names to the shared
colors. Aim for tens of lines: elements, chrome, gestures (touch scrubbing, long-press) and
motion only. Pass the model's accessibility strings to `accessibilityLabel` and
`accessibilityValue`.

Test it under jest-expo with the same fixture: it renders and exposes the model's label.
Do not re-test the model's math.

Check: `make mobile-check`, then the `ios-simulator` skill: screenshot the twin in light and
dark next to the desktop widget from the gallery, and name every difference.
