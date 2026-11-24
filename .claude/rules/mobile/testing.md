---
paths:
  - "apps/mobile/test/**"
  - "apps/mobile/src/**/*.test.ts"
  - "apps/mobile/src/**/*.test.tsx"
  - "apps/mobile/jest.config.cjs"
---

# Mobile Testing

The root `testing.md` covers the scoped-run ladder, mocking boundaries and flake triage.
This file covers what's specific to the mobile suite.

## Commands

```bash
bun run --cwd apps/mobile test                 # jest-expo, single run
bun run --cwd apps/mobile test -- <path>       # scoped by path
make mobile-check                              # lint, tsc, jest, expo export, expo install --check, single-React check
make mobile-rust-check                         # statglass-mobile for aarch64-apple-ios-sim
```

## Rules

- Run mobile tests with jest-expo on Node, never `bun test`; Bun's runner does not load the React Native preset or Expo's module mocks.
- Render with the real providers (the app's `QueryClient` factory, safe-area provider, router where needed) through the shared test helper, so a test exercises the same policy the app runs.
- Feed data through the mock transport from `@core/mock-transport` and its scenarios and fixtures, the same ones the desktop suite uses; never `jest.mock` a hook, a core module or `statglass-native` in a single test.
- Drive live data with explicit frames and fake timers ("tick 1, tick 2"), never a real 1 Hz interval.
- Query by role, label and visible text; assert what VoiceOver and the user get, not component props or class names.
- Cover the gap, not-available and each RFC section 3 error state with a fixture, not only complete frames.
- Widget model logic is tested once in `packages/core` from shared fixtures; mobile renderer tests check that the renderer draws the model, not the model's math again.
- Jest computes no layout and draws nothing, so a passing suite says nothing about how a screen looks; check that in the simulator (`ios-simulator` skill) and compare against the desktop popover, as `verification.md` requires for the desktop.
