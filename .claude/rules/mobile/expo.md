---
paths:
  - "apps/mobile/src/**/*.ts"
  - "apps/mobile/src/**/*.tsx"
  - "apps/mobile/src/**/*.css"
  - "apps/mobile/app.config.ts"
  - "apps/mobile/metro.config.cjs"
---

# Mobile App Rules

StatGlass for iPhone is an Expo app in `apps/mobile`: Expo Router with typed routes,
NativeWind on Tailwind v4, TanStack Query, and a local Swift module that wraps the Rust
facade. It is a read-only viewer of remote hosts and never monitors the phone. Design and
scope are in `plan/rfc-ios-app.md`; what the two apps share is section 4.6 and
`.claude/rules/shared-packages.md`.

## Structure

```
apps/mobile/
  src/app/          # Expo Router routes: params, layout and wiring only
  src/data/         # PhoneTransport seam and context, demo transport, phone settings store,
                    #   and the data hooks (hosts list, vitals, live store, streams, history, events)
  src/hosts/        # Hosts list rows
  src/host/         # HostScreen: pager, header, connection pill, card stack, card menu
  src/module/       # ModuleScreen: range control, scrubbable chart, events list
  src/cards/        # Popover cards: presentational over core selectors, plus their prop types
  src/widgets/      # Widget twins (react-native-svg) over shared widget models; token colors
  src/ui/           # Shared primitives such as the Dynamic Type Text roles
  src/components/   # Phase 1 placeholders (action button, "not built yet")
  src/lock/         # App lock gate and background blur
  src/debug/        # Native core diagnostics shown on the debug screen
  src/transport/    # NativeTransport and device calls into statglass-native
  src/lib/          # Providers, the QueryClient and small React Native utilities
  modules/statglass-native/  # Expo module: Swift, podspec, vendored XCFramework
  test/             # jest-expo + React Native Testing Library
```

`@/*` maps to `apps/mobile/src/*`, `@core/*` to `packages/core/src/*`, and `@native/*` to
`apps/mobile/modules/*` in tsconfig, the Metro resolver (`metro-resolve.cjs`) and jest's
`moduleNameMapper`.

## Data

- Keep route files thin: read params, call hooks, render; data and state logic live in hooks or core so tests reach them without a router.
- Get data only through the hooks in `src/data/`, built on `@core/*` and the `PhoneTransport` from `usePhoneTransport()`, so the meaning of a value matches the desktop and demo mode swaps the transport in one place.
- Import other app code through `@/` and core through `@core/`. A relative import stays in the importing file's directory (`./x`); Biome rejects `../` in `src/` and `modules/`, and tests reach only `../app.config`, `../metro-resolve.cjs` and `../scripts/*.mjs` relatively.
- Use query keys from `@core/query-keys`, never an inline array, so invalidation stays greppable and matches desktop.
- Create the app's one `QueryClient` with `createQueryClient()` from `src/lib/query-client.ts`, inside `Providers` (one query retry, no mutation retry, no focus refetch), so tests and the app run the same policy.
- Only `src/transport/` talks to the native module; screens and hooks take the `Transport` contract (or a `Pick` of it), so the mock transport drives demo mode and tests.
- Render gaps as gaps and errors as the specific RFC section 3 state from `@core/remote-errors`, never a generic failure or a zero.
- A live view that loses its session shows reconnecting or offline from `RemoteHostStatus`, never a frozen last value.

## Imports

- Never import `react-dom`, `@tauri-apps/*`, `@desktop/*`, `~/` (the desktop's alias) or anything outside `apps/mobile` except through `@core/`; Biome and the write hook both reject it, because the desktop and phone render differently.
- In app source, import `@native/*` only from `src/transport/`. Tests can use the native module's public test seam.
- Widgets and cards receive data and navigation callbacks as props. Biome excludes `@/data`, `@/transport`, Expo Router and TanStack imports from those directories.
- Install native-facing packages with `bunx expo install` so versions match the SDK; `expo install --check` in `make mobile-check` catches drift.
- Resolve `react` and `react-native` only from `apps/mobile/node_modules`; the single-React check fails the export otherwise.

## Styling

- Style with NativeWind utilities and the shared tokens in `src/global.css`; colors, module accents, status colors and motion durations come from the desktop's theme source, never literals.
- An inline `style` is for a runtime value (safe-area inset, measured size, Reanimated style) or a property with no utility, with a comment saying which.
- Register third-party components for `className` once, in one module, since NativeWind silently drops it on unknown components.
- Spacing, radii and card padding are mobile's own; do not copy desktop pixel values.

## Platform

- Wrap every screen in safe-area handling; content never sits under the notch, home indicator or Dynamic Island.
- Make every touch target at least 44 by 44 pt.
- Map type roles to iOS text styles and let them scale with Dynamic Type; never fix a font size that blocks scaling.
- Take VoiceOver labels and value text from the widget model, so both apps announce the same words.
- Respect Reduce Motion and Low Power Mode by reading the shared motion tokens, not a per-component branch.
- Follow the system's light and dark appearance; check both before calling a screen done.

Verify every screen in the simulator with the `ios-simulator` skill and compare it against the
desktop popover. Jest renders the tree but computes no layout.
