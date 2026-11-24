# Plan: StatGlass for iPhone

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.4/shared/scripts/plan_graph.py
Started: 2026-11-24. Timebox: none. Landing branch: deliver/ios-app.
Worktree: /Users/riley/Projects/statglass/.claude/worktrees/deliver-ios-app
Gate: `make agent-config-check agent-config-test agent-hooks-test verification-test architecture-check architecture-test rust-check appstore-check rust-test bindings-check mobile-check mobile-rust-check && bun run check` (about 10 min; `make check` minus `updater-patch-test`, which fails in any worktree nested under the main checkout and runs once from main after the merge; `bun run check` alone is 68 s).
Commits: conventional commit subjects are enforced by the commit hook (`type(scope): subject`). Filtered tests: `bun run test -- <path>` (desktop and packages/core), `bun run --cwd apps/mobile test -- <path>` (mobile, jest-expo), `cargo test -p <crate> <filter>` (Rust). Typecheck: `bun run typecheck`.
Runner: plain commands.
Worktree setup: `bun install --frozen-lockfile`.
Executors: phase 1 lanes run as opus `ce:builder` agents. Phases 2 to 7 run as foreman Codex runs (model gpt-6.2-sol), one run per lane, each with a contract built from the lane brief below; lane review, check-lane and landing are unchanged.

Source RFC: `plan/rfc-ios-app.md` (revision 2). Section numbers below refer to it.

## Spec

StatGlass for iPhone is a read-only viewer for the Macs and Linux servers a person already monitors with StatGlass. It reaches each host over SSH (russh inside the app, Secure Enclave key, forced-command restricted session), speaks the existing CBOR session protocol through Rust code shared with the desktop, keeps a small per-host mirror, and draws the desktop popover's card stack natively in an Expo app.

In scope (this run: RFC phases 0 to 4, verified in the iOS Simulator):

- RFC section 10 decisions 1 to 10 are accepted as written and recorded as D-entries in `plan/decisions.md` during phase 1.
- Monorepo per RFC 6: Bun workspace with the desktop at the root, `apps/mobile`, `packages/core` (`@statglass/core`).
- Phase 0 spikes are folded into the phases that need them; each writes its result into this plan's Log instead of a throwaway branch.
- Restricted phone session allowlist (open question 1): live metrics, summaries, history sync, recent rows, events, and the live process table (process interest). `UsageByApp`, `HistoricalUsage`, `UsageProcesses` and every `Space*` query are refused with `Error { code: Unsupported }`.
- The phone links `statglass-engine` with `disk_space` and `docker` gated off for iOS (open question 2). If the phase 1 binary size spike shows this is unacceptable, stop and ask.
- Restricted keys only; no Tailscale SSH mode in 1.0 (open question 7).
- Local release builds only, no EAS (open question 5). No GitHub-hosted macOS job is added (D-118, D-131).
- Host support window (open question 4): last three desktop minors and agent versions from the last 90 days, recorded in `compat/mobile-protocol.json`.
- Desktop stays at the repo root (open question 3). No alerts while closed (open question 6). No "Viewing now" indicator (open question 8).
- Native renderers from shared widget models (RFC 4.6); the Expo DOM component comparison is not run, because the accepted decision 1 already chooses Expo and 4.6 chooses native renderers.

Out of scope: RFC phases 5 and 6 (hardening checklist on devices, NAT64 test, TestFlight, App Store submission), pairing from a physical iPhone, Home Screen widgets, iPad layout, manual host entry, ProxyJump, SSH certificates, moving the desktop into `apps/desktop`, adding `docs-site` to the workspace.

Assumptions (user can override):

- The Secure Enclave is not available in the iOS Simulator, so the signer has two implementations behind one Swift protocol: Secure Enclave on device, a Keychain `ThisDeviceOnly` P-256 software key in the simulator. Simulator verification uses the software key.
- The simulator end-to-end check (phase 7) uses this Mac as the host, with Remote Login on and the phone's key installed by the pairing flow against `localhost`.
- `docs-site` keeps its own lockfile and is not a workspace member in this run; only its `@core` alias path changes.
- `bun run check`, `make check` and Playwright keep their current scope for the desktop; mobile checks are separate Make targets so the desktop gate is unchanged in meaning.

Error model:

- Rust: unchanged split (thiserror in libraries, anyhow at binaries, `CommandError` at the IPC edge, `.claude/rules/rust/error-handling.md`). Each dialer classifies its own errors into the existing `RemoteError` kinds plus the new `RemoteNotRunning` and `RemoteMonitoringOff` markers (3.2). The UniFFI facade returns `{ status: "ok", data } | { status: "error", error: CommandError }` JSON, the same shape as desktop commands; it never panics across FFI: the iOS build uses a `mobile-release` Cargo profile (inherits release, `panic = "unwind"`, because the workspace release profile aborts) and every exported function wraps its body in `catch_unwind`, mapping a panic to `CommandError::Internal`. `CommandError` moves from `src-tauri/src/error.rs` into `statglass-ipc` in phase 3 so the facade can return it.
- Live streams: a stream never fails silently. Session drop, reconnect and quiesce arrive as the existing remote status messages (`RemoteHostStatus`) on the same subscription, so screens show a reconnecting or offline state instead of a frozen value (`.claude/rules/frontend/error-handling.md`). A callback the facade cannot deliver to (JS gone) ends the subscription and is logged once.
- Host side: a restricted session's refused query gets `Error { code: Unsupported }`; `authorized_keys` edits fail closed (no partial write) with a typed error naming the path and cause.
- Mobile TS: `MobileTransport` maps facade errors to the same `CommandError` union the desktop uses, and `@statglass/core/remote-errors` turns them into user-facing states. Gaps are data, never errors. Screens render a specific error state per RFC section 3 row, never a generic failure.
- Swift: the native module is a pipe; it reports its own failures (Keychain, Secure Enclave, camera permission) as typed module errors `{ kind: "keychain" | "secureEnclave" | "camera" | "localNetwork", osStatus, message }`, which `MobileTransport` maps into a `NativeError` member that `@core/remote-errors` renders; it never interprets metric data.

## Contracts (scaffold commit)

Scaffold work done inline before dispatch: `git mv src/core packages/core/src` with every alias and path repointed (tsconfig.base.json, vite.config.ts, vitest.config.ts, docs-site/tsconfig.json and other docs-site references, biome.json includes and overrides, Makefile bindings-check, `.pre-commit-config.yaml`, `src-tauri/src/lib.rs` `BINDINGS_PATH`/`TRAY_RATES_PATH`, `scripts/architecture/test_biome_rules.py`, the `.claude/hooks` path matches, comment references in Rust); the root workspace (`"workspaces": ["apps/*", "packages/*"]`), `vite` pinned to `~8.3.5`; `packages/core/package.json` (dependency `d3-hierarchy`); the `apps/mobile/**` and desktop-side Biome restriction overrides; the two mobile Make targets with stub scripts; `bun.lock` regenerated. The scaffold gate is `bun run check` plus `make bindings-check architecture-test agent-hooks-test`.

Core imports: core's own files import each other through the `@core/*` alias, and directory imports (`@core/format`) resolve to `index.ts`, so the package is consumed through the alias on both apps, not a package export map. Mobile maps `@core/*` to `../../packages/core/src/*` in its tsconfig, Metro (`resolver.resolveRequest`) and jest (`moduleNameMapper`). `packages/core/package.json` exists to declare core's dependencies and workspace membership.

Generated output: `packages/core/src/generated/types.ts` holds every generated type and the generated runtime constants registered in `src-tauri/src/facts.rs` (`CHART_WINDOWS`, `HISTORY_TIERS` and the rest), with no `@tauri-apps` import. `src/desktop-transport/commands.ts` holds `commands` and `events`. `tray-rates.json` stays in `packages/core/src/generated/`. Both outputs come from the tauri-specta builder (constants are a builder feature, so a plain specta exporter is not an option).

Layout after phase 1 (new or moved paths only):

    package.json                  workspace root ("workspaces": ["apps/*", "packages/*"]); vite pinned to the installed major
    packages/core/
      package.json                @statglass/core; declares core's deps (d3-hierarchy); no react, react-native, expo or @tauri-apps deps
      src/                        today's src/core minus the Tauri adapters, moved with git mv
      src/generated/types.ts      generated types and constants, no @tauri-apps import
      README.md                   the 4.6 guards and the fork list
    src/desktop-transport/        Tauri adapters moved out of core
      commands.ts                 generated tauri-specta commands and events (desktop only)
      native.ts, native-docker.ts, native-history.ts, native-remote.ts, native-disk-space.ts, app-transport.ts
    apps/mobile/
      app.config.ts               bundle id, team, name from env (defaults com.tryopendata.statglass.mobile)
      metro.config.cjs            watchFolders packages/; resolveRequest maps @core/* and pins react and react-native to apps/mobile/node_modules
      jest.config.cjs             jest-expo on Node
      src/app/_layout.tsx         providers and router; wiring only
      src/app/index.tsx           first-launch screen
      src/lib/providers.tsx       QueryClient (one retry, no focus refetch) and safe area
      src/global.css              NativeWind tokens imported from the shared theme source
      test/                       jest-expo + RNTL with real providers
    crates/statglass-mobile/      UniFFI facade crate (phase 1: version() only)
    scripts/mobile/
      check.sh                    mobile lint, typecheck, jest, expo export, expo install --check, single-React check
      check-rust-ios.sh           cargo check --target aarch64-apple-ios-sim -p statglass-mobile
      build-rust-ios.sh           XCFramework for aarch64-apple-ios and aarch64-apple-ios-sim
      single-react.mjs            fails if the exported iOS bundle contains two copies of React
    compat/mobile-protocol.json   protocol range and features of current and previous App Store builds (empty until first release)
    .claude/rules/mobile/         expo.md, native-module.md, testing.md
    .claude/rules/shared-packages.md
    .claude/rules/rust/mobile.md
    .claude/skills/ios-simulator/ verify a mobile change in the simulator and compare against the popover
    .claude/skills/mobile-bridge/ change the Rust facade -> UniFFI -> XCFramework -> Expo module -> MobileTransport
    .claude/skills/widget-model/  extract a widget model into packages/core and build its native twin (4.6 guards)
    .claude/delegate.md           repo guidance for foreman/Codex contracts

Aliases: desktop keeps `@core/*`, now pointing at `packages/core/src/*` (done in the scaffold). Desktop adapters are imported as `@desktop/*` -> `src/desktop-transport/*`. Mobile imports core through the same `@core/*` alias. `@core/generated/bindings` imports become `@core/generated/types` (types) or `@desktop/commands` (the `commands` object).

Makefile targets added in the scaffold (lane a owns the Makefile afterwards and must not change these two): `mobile-check` runs `scripts/mobile/check.sh`; `mobile-rust-check` runs `scripts/mobile/check-rust-ios.sh`.

## Phases

### Phase 1: workspace, mobile shell, iOS agent setup and Rust iOS target (MVP)

Scaffold: 2a87b887
Demo: in the landing worktree, `bun run check` and `bun run test:e2e --project chromium` pass with the desktop unchanged; `make mobile-check` passes; `make mobile-rust-check` passes; `bunx expo run:ios` from `apps/mobile` (after `bunx expo prebuild`) shows the first-launch screen in the simulator.

Test cases:

- Desktop: every existing Vitest, Playwright and `e2e-perf` test passes unchanged except for import-path edits; gallery screenshots at `/?route=/dev/gallery` match main.
- `packages/core` has no import of react, react-dom, react-native, expo-*, @tauri-apps/* or @steamfield/ui, and no use of `window`, `document` or `navigator` (Biome rule plus a fixture in `make architecture-test` or Biome's own run).
- `make bindings-check` regenerates `packages/core/src/generated/types.ts` and `src/desktop-transport/commands.ts` and finds no drift; `types.ts` contains no `@tauri-apps` import.
- Mobile: the first-launch screen renders the title, "Pair with your Mac", "Add a Linux server" and "Try demo hosts" (accessible roles: buttons); the providers are the real ones; tests run under jest-expo on Node.
- Mobile: a screen file importing `react-dom`, `@tauri-apps/api` or `src/app/...` fails `bun run lint`.
- `scripts/mobile/single-react.mjs` passes on the real export and fails on a fixture bundle containing two React copies.
- `cargo check --target aarch64-apple-ios-sim -p statglass-mobile` passes; `statglass-engine`'s clock uses `CLOCK_MONOTONIC_RAW` for `target_vendor = "apple"` targets other than macOS, and `disk_space` and `docker` are compiled out on iOS.
- `make architecture-check` accepts `statglass-mobile`'s edges and an architecture-test fixture proves `statglass-mobile -> statglass-remote` is rejected.
- `make agent-config-check agent-config-test agent-hooks-test` pass with the new rules and skills; the enforce-boundaries hook blocks a React import written into `packages/core/src/` and a `react-dom` import written into `apps/mobile/src/`; the generated-edit hook blocks writes to `packages/core/src/generated/` and `src/desktop-transport/commands.ts`.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | packages/core/src/, packages/core/README.md, src/desktop-transport/, src/app/, src/main.tsx, tests/, src-tauri/examples/export_bindings.rs, src-tauri/src/lib.rs, src-tauri/src/bindings.rs, src-tauri/src/ipc.rs, tsconfig.base.json, tsconfig.json, tsconfig.test.json, vite.config.ts, vitest.config.ts, vitest.setup.ts, playwright.config.ts, biome.json, Makefile, .pre-commit-config.yaml, docs-site/tsconfig.json, docs-site/AGENTS.md, scripts/architecture/test_biome_rules.py, scripts/rename-statglass.py, scripts/test-rename-statglass.py | contracts, plan/rfc-ios-app.md 4.3 and 4.6 | existing suites | opus | running | deliver/ios-app-1a | bun run check, bindings-check, Playwright chromium pass |
| b | M | apps/mobile/, scripts/mobile/check.sh, scripts/mobile/single-react.mjs, scripts/mobile/fixtures/, .github/workflows/ci.yml, bun.lock, compat/mobile-protocol.json | contracts, ~/Projects/stacks/packages/cli/registry/stacks/mobile-expo/ | apps/mobile/test/ | opus | running | deliver/ios-app-1b | make mobile-check passes; app boots in simulator |
| c | M | CLAUDE.md, AGENTS.md, .agents/, .claude/rules/, .claude/skills/, .claude/hooks/, .claude/delegate.md, .claude/launch.json, scripts/agent-config/, scripts/agent-hooks/, plan/decisions.md, plan/PROGRESS.md, plan/README.md | contracts, plan/rfc-ios-app.md | agent-config, agent-hooks tests | opus | merged | deliver/ios-app-1c | make agent-config-check agent-config-test agent-hooks-test pass |
| d | M | crates/statglass-mobile/, crates/statglass-engine/, crates/statglass-collect/, Cargo.toml, Cargo.lock, rust-toolchain.toml, scripts/architecture/crate-edges.json, scripts/architecture/crate-edges.jq, scripts/architecture/test_crate_edges.py, scripts/architecture/rust-size-ceilings.txt, scripts/mobile/check-rust-ios.sh, scripts/mobile/build-rust-ios.sh, deny.toml | contracts, .claude/rules/rust/platform.md | cargo tests in owned crates, architecture-test | opus | merged | deliver/ios-app-1d | make mobile-rust-check, architecture-check, architecture-test, rust-check pass |

#### Lane a brief

- Goal: make `packages/core/src` (moved there by the scaffold) platform-free: move the Tauri adapters to `src/desktop-transport/`, split the generated bindings into `types.ts` and desktop `commands.ts`, and enforce the core boundary, keeping the desktop's behavior and every desktop check unchanged.
- Interface: Move `app-transport.ts`, `transport/native.ts`, `transport/native-docker.ts`, `transport/native-history.ts`, `transport/native-remote.ts`, `transport/native-disk-space.ts` and their tests to `src/desktop-transport/`. Add the alias `@desktop/*` -> `src/desktop-transport/*` (tsconfig.base.json, vite.config.ts, vitest config). The export (`export_bindings` and the path constants in `src-tauri/src/lib.rs:58-68,170-191`, the test reading `BINDINGS_PATH` in `src-tauri/src/ipc.rs`) writes `packages/core/src/generated/types.ts` (every type plus the builder's constants, no `@tauri-apps` import) and `src/desktop-transport/commands.ts` (`commands` and `events`), both from the tauri-specta builder. If rc.25 cannot emit two files, export once to a string and split it deterministically in `export_bindings` (types and constants vs. commands and events), with a Rust test that `types.ts` contains no `@tauri-apps` import. Rewrite the 394 importers of `@core/generated/bindings` to `@core/generated/types` or `@desktop/commands` mechanically. Update the Makefile `bindings-check` target to check both outputs, `.pre-commit-config.yaml` excludes, Biome, `scripts/architecture/test_biome_rules.py` (add a probe that a React, react-native or @tauri-apps import under `packages/core/src` fails lint, and that `window` use fails), and `scripts/rename-statglass.py` paths. Leave the scaffold's `mobile-check` and `mobile-rust-check` Makefile targets as they are.
- Behavior: `packages/core/src` must not import `@steamfield/ui` (today `remote-connection.ts:6` imports `GifTheme` type); replace it with a core-owned string-literal union of the theme names, and keep the mapping to the `@steamfield/ui` type in the desktop app. Biome overrides: the scaffold already moved the `src/core/**` rules to `packages/core/**`; add `react-native`, `expo`, `expo-*`, `@tauri-apps/*` and `@steamfield/ui` to the restricted imports, plus `noRestrictedGlobals` for `window`, `document`, `navigator` (tests exempt where they use happy-dom). The `apps/mobile/**` and desktop-side overrides exist from the scaffold; keep them. Core tests that use `@tests/...` fixtures keep working (alias unchanged). `vitest.config.ts` includes `packages/core/**/*.test.ts` and keeps the generated-dir coverage exclusion at its new path.
- Decisions already made: desktop stays at the root; docs-site stays outside the workspace; no `@statglass/react` or `@statglass/tokens` package; pure move, no refactors.
- Out of scope: any behavior change, any widget model extraction, moving hooks, editing `.claude/` (lane c updates the hooks and docs to the new paths), touching `apps/mobile`, manifests or lockfiles.
- Done when: `bun run check`, `make bindings-check`, `make architecture-test`, `bun run build` and `bun run test:e2e --project chromium` pass; no file under `packages/core/src` (outside `generated/` tests) imports `@tauri-apps/*` or `@steamfield/ui`.

#### Lane b brief

- Goal: add the Expo app shell at `apps/mobile` from the `stacks` `mobile-expo` stack's app half, with the first-launch screen, real providers, tests, the single-React check and Linux CI jobs.
- Interface: follow `~/Projects/stacks/packages/cli/registry/stacks/mobile-expo/` (STACK.md Setup step 1 and the `files/apps/mobile` tree) for Expo Router with typed routes, NativeWind on its CSS-first line with Tailwind v4, TanStack Query (one production `QueryClient`, one query retry, no mutation retry, no focus refetch), jest-expo and React Native Testing Library with real providers, Metro config, generated uncommitted `ios/` via prebuild. Drop the API, Postgres, Drizzle, zod schemas and Clerk. Package name `@statglass/mobile`, dependency `"@statglass/core": "workspace:*"`; core is imported through the `@core/*` alias, mapped in mobile's tsconfig, Metro `resolver.resolveRequest` and jest `moduleNameMapper`. Install with `bunx expo install` so versions match the SDK; add `react-native-svg`, `react-native-gesture-handler`, `react-native-reanimated` now (used in phase 6). `app.config.ts` reads `STATGLASS_MOBILE_BUNDLE_ID`, `STATGLASS_MOBILE_TEAM_ID`, `STATGLASS_MOBILE_NAME` with defaults `com.tryopendata.statglass.mobile`, `YWA9Q642YP`, `StatGlass`. Metro: `watchFolders` includes `../../packages`; `resolver.resolveRequest` maps `@core/*` and forces `react`, `react/*`, `react-native` and `react-native/*` to `apps/mobile/node_modules` (not `extraNodeModules`, which is only a fallback and would let the root React 19.3 win). `scripts/mobile/check.sh` runs, from the repo root: Biome on `apps/mobile`, mobile `tsc` (after route type generation), jest, `expo export --platform ios` into an ignored dir, `expo install --check`, then `node scripts/mobile/single-react.mjs <export dir>`.
- Behavior: first-launch screen per RFC 1.4: app name, one sentence on what it does, primary "Pair with your Mac", secondary "Add a Linux server", and "Try demo hosts"; the three actions are buttons with accessible labels and do nothing yet beyond navigating to placeholder routes `pair`, `pair-linux`, `demo` that say "Not built yet" (replaced in phases 6 and 7). Colors come from the shared token source: check whether NativeWind can read `src/app/styles/theme.css` (or tokens.css) directly; if it can, import it; if it cannot, write a small generator `apps/mobile/scripts/gen-theme.mjs` that emits `apps/mobile/src/theme.generated.css` and a plain color map from `theme.css`, with a check that fails on drift. Record which in your report. Light and dark appearance follow the system. `single-react.mjs` counts React module definitions in the Hermes/JS bundle by package path and exits 1 with the paths when more than one copy exists; its fixture test runs under `node --test`. Add `apps/mobile/test/core-import.test.ts` that imports `@core/format` and `@core/live-state` and calls one function from each, proving the alias works under jest. CI: add a Linux job `mobile` to `.github/workflows/ci.yml` that runs on changes under `apps/mobile/**`, `packages/**`, `bun.lock`, `scripts/mobile/**`, and runs `make mobile-check`'s Linux-capable steps (all of check.sh runs on Linux). No macOS runner.
- Decisions already made: Expo, not Tauri mobile or SwiftUI; local builds only; mobile tests never use `bun test`; each app pins its own React.
- Biome: the scaffold's root `biome.json` already lints `apps/mobile` with an override that restricts `react-dom`, `@tauri-apps/*` and desktop app imports; a lint probe for it belongs to lane a. If mobile needs other Biome settings (React Native globals), report them instead of editing `biome.json`.
- Out of scope: demo mode data, MobileTransport, the native module, widgets, any screen beyond the first-launch screen and placeholders, Android.
- Done when: `make mobile-check` passes; `bunx expo prebuild --platform ios` then `bunx expo run:ios` on a booted simulator shows the first-launch screen (attach a screenshot path in your report); `bun run check` at the root still passes.

#### Lane c brief

- Goal: set up the agent guidance for iOS and shared-package work (rules, skills, hooks, delegate guide, CLAUDE.md) and record the accepted RFC decisions, so every later lane and foreman run follows the same conventions.
- Interface: new rules with `paths:` frontmatter in the style of `.claude/rules/frontend/react.md`: `.claude/rules/mobile/expo.md` (routes thin, data hooks over `@statglass/core`, one QueryClient, NativeWind tokens, safe areas, 44 pt targets, Dynamic Type, VoiceOver labels from models, no react-dom/@tauri-apps/src/app imports), `.claude/rules/mobile/native-module.md` (Swift module is a pipe; lifecycle calls never block; signer protocol with Secure Enclave and simulator software key; UniFFI regeneration; no metric interpretation in Swift), `.claude/rules/mobile/testing.md` (jest-expo on Node, real providers, mock transport fixtures shared with desktop, simulator screenshot comparison per `verification.md`), `.claude/rules/shared-packages.md` (the seven guards in RFC 4.6, pull-never-push, fork-not-flag, model purity on the 1 Hz path), `.claude/rules/rust/mobile.md` (statglass-mobile facade rules: JSON `{status,data|error}` shape, catch_unwind at FFI, no `statglass-remote` dependency, iOS cfg gating, russh pin). Update existing rules and hooks that name `src/core` to `packages/core/src` and `src/desktop-transport` (enforce-boundaries.sh, block-generated-edits.sh, format-changed.sh, lint-on-write.sh, pre-bash.sh, rule `paths:`), and extend enforce-boundaries.sh with the mobile rules (no react-dom/@tauri-apps/desktop app imports under `apps/mobile/`; no react, react-native, expo or @tauri-apps under `packages/core/src/`). Skills: `ios-simulator` (prebuild, `expo run:ios`, the Claude simulator tool's attach/screenshot flow, `xcrun simctl io booted screenshot`, light/dark and Dynamic Type sizes, comparing against the desktop popover screenshot from the dev gallery, naming every difference), `mobile-bridge` (the change path Rust facade -> `make bindings`/types export -> `scripts/mobile/build-rust-ios.sh` -> Expo module -> MobileTransport, with the checks at each step), `widget-model` (extract one widget's model into `packages/core/src/widget-models/<name>.ts`, keep the desktop component's name and props, write model tests from shared fixtures, then the native twin). `.claude/delegate.md`: what a foreman contract for this repo must include (worktree setup `bun install --frozen-lockfile`, filtered test commands, the gate, hosted runner policy, generated-file rules, one-commit-per-lane, no pushes). CLAUDE.md: architecture tree, rules index rows, quick commands (`make mobile-check`, `make mobile-rust-check`, mobile dev command), the new crates. Register new rules and skills in `scripts/agent-config/shared.txt` and regenerate `AGENTS.md` and `.agents/` with `make agent-config`. Add D-entries for RFC section 10 decisions 1 to 10 and the open-question answers in this plan's Spec to `plan/decisions.md` (next free D-number, same format as the latest entries), mark the RFC accepted in `plan/README.md`, and add a PROGRESS.md entry.
- Behavior: hook fixture tests in `scripts/agent-hooks/` cover: React import into `packages/core/src/x.ts` blocked; `react-dom` import into `apps/mobile/src/app/x.tsx` blocked; write to `packages/core/src/generated/types.ts` and `src/desktop-transport/commands.ts` blocked; an ordinary edit in each new area allowed.
- Decisions already made: the Spec's in-scope list; rules stay in `.claude/` with `.agents/` generated; skills are repo skills, not ce plugin skills (they are StatGlass-specific).
- Out of scope: editing code outside `.claude/`, `scripts/agent-config/`, `scripts/agent-hooks/` and the listed docs; restructuring `plan/`.
- Done when: `make agent-config-check agent-config-test agent-hooks-test verification-test` pass and `codex debug prompt-input` from the root lists the three new skills (check, do not commit its output).

#### Lane d brief

- Goal: make the Rust workspace build for iOS: the clock fix, iOS gating in engine and collect, the `statglass-mobile` crate with UniFFI and one exported `version()`, the XCFramework build script, crate-edge rules and the binary size spike.
- Interface: `crates/statglass-mobile` (`crate-type = ["staticlib", "lib"]`, UniFFI proc-macro setup at the current uniffi release, pinned exactly) exporting `fn version() -> String` returning the crate version and protocol range from `statglass-proto`. It depends on `statglass-schema`, `statglass-proto`, `statglass-store`, `statglass-engine`; never `statglass-remote`. `crate-edges.json` gains `statglass-mobile` and the architecture-test fixtures gain a negative case for `statglass-mobile -> statglass-remote`. `rust-toolchain.toml` adds targets `aarch64-apple-ios` and `aarch64-apple-ios-sim`. `scripts/mobile/check-rust-ios.sh` runs `cargo check --target aarch64-apple-ios-sim -p statglass-mobile` (and clippy with `-D warnings` for that target). `scripts/mobile/build-rust-ios.sh` builds release staticlibs for both targets, generates Swift bindings with uniffi-bindgen, and assembles `apps/mobile/modules/statglass-native/ios/StatglassCore.xcframework` (output path git-ignored by lane b's `.gitignore`; if you need an ignore entry outside your files, report it).
- Behavior: `statglass_engine::continuous_ns` uses `CLOCK_MONOTONIC_RAW` when `target_vendor = "apple"` and not macOS (keep the macOS path as is; `CLOCK_BOOTTIME` stays for Linux); add a unit test that two calls are monotonic. Gate `disk_space`, `docker`, `docker_runtimes` and `docker_storage` (`crates/statglass-collect/src/lib.rs:726-731`) and their non-platform users (such as `container_names.rs`) off for `target_os = "ios"`, with `bollard`/`hyper` moved to `[target.'cfg(not(target_os = "ios"))'.dependencies]`; do the same for any engine module that uses them. collect's macOS private-API code stays `target_os = "macos"`. Add a `[profile.mobile-release]` (inherits release, `panic = "unwind"`) to the root `Cargo.toml`; `build-rust-ios.sh` builds with it, and `statglass-mobile`'s exported function wraps its body in `std::panic::catch_unwind`. Desktop and Linux builds are unchanged. Spike: record the `mobile-release` `libstatglass_mobile.a` size for `aarch64-apple-ios` and the stripped size of a minimal linked binary if measurable, plus the list of engine modules compiled in, in your report. If the size exceeds 25 MB stripped, say so plainly.
- Decisions already made: engine is linked on iOS for 1.0 with disk_space and docker gated off; russh is not added yet (phase 2).
- Out of scope: the session extraction, any FFI beyond `version()`, the Expo module source, Make targets (scaffold owns `mobile-rust-check`).
- Done when: `make mobile-rust-check`, `make architecture-check architecture-test`, `make rust-check` and `cargo test -p statglass-engine clock` pass, and `scripts/mobile/build-rust-ios.sh` produces the XCFramework.

### Phase 2: shared session crate and dialer seam

Demo: `cargo test -p statglass-session -p statglass-remote -p statglass-ssh` and `cargo test -p statglass remote` pass with the desktop on the OpenSSH dialer. `make ssh-docker-test` runs the `statglass_session::conformance` suite over both `RusshDialer` and `OpenSshDialer` against the Linux agent in Docker. `make mobile-rust-check` builds `statglass-session` and `statglass-ssh` for `aarch64-apple-ios-sim`.
Depends on: phase 1

Code facts this phase relies on (checked 2026-11-24; the RFC's line numbers have drifted):

- `dial` is at `transport.rs:225-314`. Its stderr classification calls `install::setup_ssh_error` at `transport.rs:323`. `connect`/`race_routes`/`combine` are at `transport.rs:396-457`, and `kill_on_drop` is at `transport.rs:179`.
- `RemoteSource` dials in two places: the main loop at `source.rs:173` and route promotion at `source.rs:491`.
- `network_changed` (`source.rs:117-120`) only bumps a counter. The Tailscale-to-LAN promotion is at `source.rs:477-495`, and the 30 s heartbeat is at `source.rs:889-897`.
- `source.rs:662,679` call `server::status_from_wire`/`process_from_wire` (`server.rs:433,473`). The source tests call `server::tests::provider().hello()` (`source.rs:983,1695,1851`).
- `calls.rs:19-121` is the host `Answering`; `calls.rs:127-248` is the client half.
- `control.rs`, `rr.rs`, `agent_install/*` use `transport::sh_c`/`sh_word`/`ssh_command`/`helper_command`.
- `AGENT_NOT_RUNNING` is at `agent_layout.rs:15`.
- The repo has no Docker sshd fixture today. `scripts/agent-update-qa/` runs systemd containers without SSH, and the agent SSH tests (`crates/statglass-agent/tests/ssh.rs`, `crates/statglass-remote/tests/linux_agent_qa.rs`) are `#[ignore]` against a hand-supplied host.

Test cases:

- `statglass-session` depends only on schema, proto, store and engine. It has no `statglass-remote` edge (architecture-check). Its tokio features exclude `process`. It passes `cargo check --target aarch64-apple-ios-sim`.
- Moved tests pass unchanged in `statglass-session`: codec, clock, client calls, mirror, pages, network, source, status.
- Every name `src-tauri` and `statglass-agent` import from `statglass_remote` still resolves, through re-exports. Only the three `RemoteSource::new` call sites change.
- Host `Answering` and its `MAX_IN_FLIGHT` tests stay in `statglass-remote` and pass.
- `RemoteSource` dials only through its injected dialer. A fake dialer sees one dial per attempt, and `ConnectionStatus.route` is the winning target's route.
- Promotion, on a network change while on a Tailscale target: after the 2 s debounce it races only targets whose route is better (LAN). A success replaces the session; a failure keeps the current one. A session already on LAN never promotes, and Tailscale targets never promote among themselves.
- `RemoteError::Routes` with two targets displays exactly as today (`"LAN: x; Tailscale: y"`). `ConnectionFailureKind::from_error` picks the most actionable kind across N. `route_failures` has one entry per target.
- Race, single target: the error comes back unwrapped.
- Race: the preferred target winning within `ROUTE_GRACE` (500 ms) is chosen, and the loser is dropped (drop counted).
- Race: a less-preferred success is returned once the grace expires while the preferred target is still pending. Elapsed time equals the grace, under paused time.
- Race: a retryable failure on the preferred target returns the next success immediately.
- Race: a non-retryable failure that arrives before the decision ends the race with that error (today's rule, `transport.rs:426-431`).
- Race: two successes with different host ids return `Identity`.
- Race: all targets failing returns `Routes` in target order. If every failure is retryable and one is `AgentNotRunning`, the result is `AgentNotRunning` with the joined text.
- Race, three targets: LAN fails and the 100.x target succeeds while MagicDNS is pending. The race waits the grace for MagicDNS, then takes 100.x.
- Handshake: no Hello within 10 s means the stream is closed first, then `classify` gets `TimedOut` with the full stderr tail.
- Handshake: a stderr marker line maps to `AgentNotRunning` whatever the dialer.
- Handshake: the local host id gives `Identity`; an unexpected id gives `IdentityMismatch`; a negotiation failure gives `IncompatiblePeer`. On success `HelloAck` is written.
- Endpoint validation fails with `Protocol` before any dial for: zero or more than four targets, an invalid host, port 0, or a user with whitespace or a leading `-`.
- OpenSSH: the existing classification tests pass unchanged (`transport/classify_tests.rs`, setup errors, unreachable kinds, timeouts).
- OpenSSH argv: the hardening options are unchanged. `-oPort=`/`-oUser=` appear only when set, and `-F <file>` only when configured, all before `--`.
- OpenSSH with a fake `ssh` program: dropping the dial future kills the child; `close()` kills and reaps it; the stderr tail is capped at 8 KiB.
- `EndpointConfig::endpoint()` maps `lan`, then `tailscale`, to targets in that order, with no port, user or keys. `statglass_remote::connect(config, local, expected)` behaves as before.
- russh, against an in-process russh server: the exec request carries exactly `endpoint.command.serve_command()`, and bytes flow both ways. The only channel request is `exec` (no PTY, env or forwarding).
- russh failure classification:
  - A host key not in `host_keys` gives `HostKey` with no auth attempted.
  - Empty `host_keys` or a missing `user` gives `Protocol` before connecting.
  - A rejected key gives `Authentication`.
  - A refused port gives `Unreachable{Refused}`, and `*.invalid` gives `Unreachable{NameNotResolved}`.
  - A silent listener gives `Timeout` within `connect_timeout`.
- russh: extended data (stderr) lands in `StderrTail`, capped.
- russh cancellation: dropping the dial future mid-auth closes the TCP connection within 1 s (the server observes it). Dropping a `DialedStream` closes it within 1 s. `close()` sends channel EOF, then disconnects.
- russh: keepalive is 15 s with a maximum of 3 misses.
- Signer: a `SoftwareSigner` signature verifies.
- DER to SSH signature: an `r` with the high bit set gets a leading zero byte, and a short `r` stays a minimal mpint. Malformed DER gives `SignerError::Invalid`, which maps to `Authentication`. `SignerError::Unavailable` also maps to `Authentication` and keeps its message.
- Docker conformance, over both dialers: `live_session`, `agent_not_running` and `source_syncs_mirror` pass.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-session/src/codec.rs, crates/statglass-session/src/calls.rs, crates/statglass-session/src/clock.rs, crates/statglass-session/src/mirror.rs, crates/statglass-session/src/mirror/, crates/statglass-session/src/mirror_sink.rs, crates/statglass-session/src/mirror_error.rs, crates/statglass-session/src/pages.rs, crates/statglass-session/src/wire.rs, crates/statglass-session/src/network.rs, crates/statglass-session/src/network/, crates/statglass-session/src/source.rs, crates/statglass-session/src/source/, crates/statglass-session/src/conformance.rs, crates/statglass-session/src/test_support.rs, crates/statglass-remote/src/ (except transport.rs, transport/), src-tauri/src/remote/registration.rs, src-tauri/src/remote_tests.rs, src-tauri/src/remote/setup/linux_tests.rs, scripts/architecture/rust-size-ceilings.txt | contracts, RFC 4.2, 4.5 | moved unit tests, conformance | gpt-6.2-sol | pending | | `cargo test -p statglass-session -p statglass-remote` and `cargo test -p statglass remote` pass; architecture-check passes |
| b | M | crates/statglass-session/src/connect.rs, crates/statglass-session/src/connect/, crates/statglass-remote/src/transport.rs, crates/statglass-remote/src/transport/, crates/statglass-remote/tests/docker_openssh.rs | contracts, transport.rs | connect/tests.rs, transport tests | gpt-6.2-sol | pending | | `cargo test -p statglass-session connect` and `cargo test -p statglass-remote transport` pass |
| c | M | crates/statglass-ssh/src/, crates/statglass-ssh/tests/, scripts/ssh-docker/ | contracts, RFC 2.2, 2.7, 3.1, 4.2 | statglass-ssh tests | gpt-6.2-sol | pending | | `cargo test -p statglass-ssh` passes; `make ssh-docker-test` runs |

#### Scaffold contracts (phase 2)

Scaffold edits to existing files (it also runs `make agent-config` and `make deny`):

- `Cargo.toml` adds workspace deps `statglass-session`, `statglass-ssh`, and `russh = { version = "=<X>", default-features = false, features = [<one crypto backend>] }`.
  - The local cargo cache has no russh, so the version must be checked with `cargo info russh`. Pin exactly; it must be at least the 0.61 the RFC names.
  - Choose the crypto backend whose build passes `make mobile-rust-check` and `make rust-linux-check`.
  - `p256` and `sha2` are pinned to the versions russh already resolves in `Cargo.lock`.
- `Cargo.lock`.
- `crates/statglass-remote/Cargo.toml` adds the `statglass-session` dep, plus a dev-dep with the `conformance` feature.
- `crates/statglass-remote/src/lib.rs`: the `RemoteError`/`UnreachableKind`/`Result` definitions move out. Add `pub use statglass_session::{RemoteError, RouteError, UnreachableKind, Result, Route, Endpoint, Target, PinnedHostKey, Dialer, SshSession, RemoteCommand, HostClock, DIAL_TIMEOUT_MS, AGENT_NOT_RUNNING}` and `pub use transport::OpenSshDialer`.
- `crates/statglass-remote/src/transport.rs`:
  - The moved items go (`RemoteCommand`, `sh_c`, `sh_word`, `shell_quote`, `helper_command` from lines 21-106, 154-156, 182-189; `Route` from 116-121; the `SshSession` struct from 190-223), replaced by `pub(crate) use statglass_session::command::{…}`.
  - `dial` builds the moved `SshSession` through `SshSession::new` with a `ChildClose { child, stderr_task }`.
  - `combine` builds `Routes`.
  - Add `pub struct OpenSshDialer` and its `impl Dialer` stub, returning `Err(Transport("not implemented"))`.
  - Add `EndpointConfig::endpoint(&self) -> Endpoint`.
  - Add `impl Display for Route` in session.
- `crates/statglass-remote/src/source/status.rs` (`BothRoutes` arms become `Routes`).
- `crates/statglass-remote/src/agent_layout.rs:15` re-exports the moved constant.
- `src-tauri/src/remote.rs:242` and `src-tauri/src/query/map.rs:111` (rename the arm).
- `scripts/architecture/crate-edges.json`:
  - `statglass-session` → schema, proto, store, engine.
  - `statglass-ssh` → session (dev: session with `conformance`, plus schema, proto, engine, store, as the Docker test needs).
  - `statglass-remote` gains session.
  - A negative fixture proves `statglass-session -> statglass-remote` is rejected.
- `scripts/mobile/check-rust-ios.sh` adds `-p statglass-session -p statglass-ssh` to its check and clippy lines.
- `Makefile` gets an `ssh-docker-test` target that runs `scripts/ssh-docker/run.sh`.
- `.claude/rules/rust/crates.md` and the CLAUDE.md crate list.

New files, `crates/statglass-session/`:

- `Cargo.toml`: deps for the moved modules; tokio features `rt`, `sync`, `time`, `io-util`, `macros`, with no `process`; feature `conformance`.
- `src/lib.rs`: module list and re-exports.
- `src/error.rs`: `RemoteError` moved, with `BothRoutes { lan, tailscale }` replaced by `Routes(Vec<RouteError>)`; `#[error]` joins `"{route}: {error}"` with `"; "`; `retryable()` is unchanged.
- `src/command.rs`: `RemoteCommand`, `sh_c`, `sh_word`, `shell_quote`, `helper_command` and their tests (`transport.rs:693-802`), moved verbatim.
- `src/dialer.rs` and `src/connect.rs`:

```rust
// crates/statglass-session/src/error.rs
#[derive(Debug)]
pub struct RouteError { pub route: Route, pub host: String, pub error: RemoteError }

// crates/statglass-session/src/dialer.rs
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Route { Lan, Tailscale } // Ord is preference; Display "LAN" / "Tailscale"

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target { pub route: Route, pub host: String } // alias, DNS name or address literal

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedHostKey { pub algorithm: String, pub sha256: String } // "ssh-ed25519", "SHA256:…"

pub const MAX_TARGETS: usize = 4;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    pub targets: Vec<Target>,          // preference order
    pub port: Option<u16>,             // None: dialer default (OpenSSH config / 22)
    pub user: Option<String>,          // None: OpenSSH config; russh requires Some
    pub host_keys: Vec<PinnedHostKey>, // OpenSSH ignores (known_hosts); russh requires non-empty
    pub command: RemoteCommand,
}
impl Endpoint {
    pub fn validate(&self) -> Result<()>;
    pub fn single_route(&self) -> Option<Route>;             // Some when exactly one target
    pub fn better_than(&self, route: Route) -> Option<Endpoint>; // targets with a better route, None if none
}

pub trait Dialer: Send + Sync + 'static {
    /// Opens the transport to `target` and starts `endpoint.command`. SSH-level failures
    /// (connect, host key, auth) come back already classified.
    fn dial<'a>(&'a self, endpoint: &'a Endpoint, target: &'a Target)
        -> BoxFuture<'a, Result<DialedStream>>;
    /// A stream that ended or stalled before the StatGlass Hello, after `close` finished.
    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError;
}

/// Dropping it must release the transport too (OpenSSH: kill_on_drop; russh: drop the
/// handle and abort its task). `close` is the orderly path.
pub struct DialedStream {
    pub reader: Pin<Box<dyn AsyncRead + Send>>,
    pub writer: Pin<Box<dyn AsyncWrite + Send>>,
    pub stderr: StderrTail,
    pub close: Box<dyn Close>,
}
pub trait Close: Send + 'static { fn close(self: Box<Self>) -> BoxFuture<'static, ()>; }

pub const STDERR_TAIL_BYTES: usize = 8192;
#[derive(Clone, Default)]
pub struct StderrTail(Arc<Mutex<Vec<u8>>>);
impl StderrTail { pub fn push(&self, bytes: &[u8]); pub fn text(&self) -> String; }

pub struct DialFailure<'a> { pub target: &'a Target, pub stderr: &'a str, pub outcome: HandshakeFailure }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandshakeFailure { TimedOut, Closed, Io(std::io::ErrorKind), Invalid, NotHello }
impl HandshakeFailure { pub fn sentence(self) -> &'static str; } // today's transport.rs:378-392 text

pub const AGENT_NOT_RUNNING: &str = "statglass-agent: not running";
/// Marker lines the shared handshake checks before asking the dialer (phase 5 adds more).
pub fn marker_error(target: &Target, stderr: &str) -> Option<RemoteError>;

pub struct SshSession {
    pub hello: Hello, pub negotiated: Negotiated, pub route: Route, pub target: Target,
    pub reader: Pin<Box<dyn AsyncRead + Send>>, pub writer: Pin<Box<dyn AsyncWrite + Send>>,
    close: Box<dyn Close>,
}
impl SshSession {
    pub fn new(hello: Hello, negotiated: Negotiated, target: Target, stream: DialedStream) -> Self;
    pub async fn close(self);
}

// crates/statglass-session/src/connect.rs (stub: not implemented)
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
pub const DIAL_TIMEOUT_MS: i64 = 10_000;
pub const ROUTE_GRACE: Duration = Duration::from_millis(500);
pub const PROMOTION_DEBOUNCE: Duration = Duration::from_secs(2);
pub async fn connect(dialer: &dyn Dialer, endpoint: &Endpoint, local: HostId,
                     expected: Option<HostId>) -> Result<SshSession>;

// crates/statglass-session/src/conformance.rs (feature "conformance"; stubs panic "not implemented")
pub struct ConformanceHost { pub endpoint: Endpoint, pub stopped: Endpoint, pub host_id: HostId }
pub async fn live_session(dialer: &dyn Dialer, host: &ConformanceHost);
pub async fn agent_not_running(dialer: &dyn Dialer, host: &ConformanceHost);
pub async fn source_syncs_mirror(dialer: Arc<dyn Dialer>, host: &ConformanceHost);
```

New files, `crates/statglass-ssh/`:

- `Cargo.toml`: russh pinned; `p256`, `sha2`; feature `software-signer`.
- `src/lib.rs`.
- `src/dialer.rs` and `src/signer.rs` stubs:

```rust
pub struct RusshConfig { pub connect_timeout: Duration, pub keepalive_interval: Duration, pub keepalive_max: usize } // Default 5 s / 15 s / 3
pub struct RusshDialer { /* signer, config */ }
impl RusshDialer { pub fn new(signer: Arc<dyn Signer>) -> Self; pub fn with_config(signer: Arc<dyn Signer>, config: RusshConfig) -> Self; }
impl Dialer for RusshDialer { … }

pub trait Signer: Send + Sync + 'static {
    /// SEC1 uncompressed P-256 point, 65 bytes (what SecKeyCopyExternalRepresentation returns).
    fn public_key(&self) -> &[u8];
    /// ECDSA P-256 over SHA-256 of `data`, ASN.1 DER (SecKeyCreateSignature .ecdsaSignatureMessageX962SHA256).
    fn sign(&self, data: Vec<u8>) -> BoxFuture<'static, std::result::Result<Vec<u8>, SignerError>>;
}
#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    #[error("signing key unavailable: {0}")] Unavailable(String),
    #[error("signing refused: {0}")] Refused(String),
    #[error("invalid signature: {0}")] Invalid(String),
}
pub fn der_to_ssh_signature(der: &[u8]) -> std::result::Result<Vec<u8>, SignerError>;
#[cfg(any(test, feature = "software-signer"))]
pub struct SoftwareSigner; // generate(), from_pkcs8_der(&[u8]), authorized_key_line(comment) -> String
```

Docker contract (environment variables `scripts/ssh-docker/run.sh` exports to both Docker test files):

- `STATGLASS_SSH_DOCKER_HOST`, `STATGLASS_SSH_DOCKER_PORT`, `STATGLASS_SSH_DOCKER_USER`
- `STATGLASS_SSH_DOCKER_KEY` (PKCS#8 DER P-256 path)
- `STATGLASS_SSH_DOCKER_HOST_KEY` (`algorithm SHA256:…`)
- `STATGLASS_SSH_DOCKER_SSH_CONFIG` (an `ssh -F` file with alias `statglass-docker`, its port, user, identity and a known_hosts entry)
- `STATGLASS_SSH_DOCKER_AGENT_BIN`, `STATGLASS_SSH_DOCKER_SOCKET`
- `STATGLASS_SSH_DOCKER_HOST_ID`

#### Lane a brief

- Goal: extract the client half of `statglass-remote` into `statglass-session` with no behavior change, and make `RemoteSource` dial through an injected `Arc<dyn Dialer>` and an `Endpoint`, so the phone can reuse it. Route promotion is generalized to N targets.
- Interface:
  - Move these from `crates/statglass-remote/src/` with `git mv` into `crates/statglass-session/src/`: `codec.rs`, `clock.rs`, `mirror.rs` + `mirror/`, `mirror_sink.rs`, `mirror_error.rs`, `pages.rs`, `network.rs` + `network/`, `source.rs` + `source/`, and the client half of `calls.rs` (`Call`, `Line`, `call`, `open`, `LineGuard`, `Pending`, `QUEUED`, and the tests at `calls.rs:250-412`).
  - Host `Answering`, `answer`, `failed` and `MAX_IN_FLIGHT` stay in `crates/statglass-remote/src/answering.rs`.
  - `status_to_wire`, `status_from_wire` and `process_from_wire` (`server.rs:416-498`) move to `statglass-session/src/wire.rs`, and `server.rs` imports them.
  - `statglass-session/src/test_support.rs` gets `fixture_hello() -> Hello`, replacing `server::tests::provider().hello()` in the moved source tests, plus copies of `mac_host`/`bare_host`/`eventually` as the moved tests need.
  - Signature: `RemoteSource::new(record: HostRecord, local: HostId, dialer: Arc<dyn Dialer>, endpoint: Endpoint, on_status: StatusCallback, mirror: Option<Arc<dyn MirrorSink>>) -> Arc<Self>`.
  - The three `src-tauri` call sites pass `Arc::new(OpenSshDialer::default())` and `saved.endpoint().endpoint()`.
  - `statglass-remote/src/lib.rs` re-exports every moved public name, so `src-tauri` and `statglass-agent` imports do not change.
  - Move the `rust-size-ceilings.txt` entry for `source.rs` to its new path.
  - Implement `conformance.rs` over `statglass_session::connect` and `RemoteSource`:
    - `live_session`: Hello host id equals `host_id`; send `Interest{detail:true}`; a `LayoutDef` and a `LiveFrame` arrive within 15 s; a Ping gets its Pong; `close()`.
    - `agent_not_running`: `connect` over `stopped` returns `AgentNotRunning`.
    - `source_syncs_mirror`: a `RemoteSource` with a temp `Mirror` reports `connected` and the M1 cursor advances within 60 s.
- Behavior:
  - Both dial sites (`source.rs:173`, `source.rs:491`) call `statglass_session::connect(&*self.dialer, …)`.
  - Promotion runs when `network` changed and the current route is not the best in the endpoint: after `PROMOTION_DEBOUNCE`, race `endpoint.better_than(current.route)`. Success replaces the session; failure keeps the current one. It never re-races same-route targets.
  - `status.record_failure` uses `endpoint.single_route()`.
  - Everything else is unchanged: sync tiers, backoff, heartbeat, thread-per-source.
- Decisions already made:
  - `RemoteCommand` and the quoting helpers live in `session::command` (scaffold), because `Endpoint` carries the command and the desktop's command errors must still surface at dial time.
  - No `process` feature in `statglass-session`.
  - The MirrorPolicy, sync policy, injectable runtime, `quiesce`, recent-before-sync and dead-route drop are phase 3.
- Out of scope: `connect.rs`, `transport.rs`, the dialers, `statglass-ipc`, any change to sync behavior, and manifests (scaffold-owned; report if a dep is missing).
- Done when:
  - `cargo test -p statglass-session`, `cargo test -p statglass-remote` and `cargo test -p statglass remote` pass.
  - `cargo clippy -p statglass-session -p statglass-remote -p statglass --all-targets -- -D warnings` and `make architecture-check` pass.
  - `cargo check --target aarch64-apple-ios-sim -p statglass-session` passes.
  - `git diff -M --stat` shows the moves as renames.

#### Lane b brief

- Goal: implement the dialer seam: the generic handshake and N-target race in `statglass-session`, and `OpenSshDialer`, so the desktop dials through `Dialer` with today's behavior and error text.
- Interface:
  - `crates/statglass-session/src/connect.rs` implements the scaffold's `connect`, with tests in `connect/tests.rs` using a scripted fake `Dialer` (per target: delay, Hello, failure, stderr) and paused time.
  - `crates/statglass-remote/src/transport.rs` adds `pub struct OpenSshDialer { program: PathBuf, config_file: Option<PathBuf> }`:
    - `Default` uses `/usr/bin/ssh`.
    - `OpenSshDialer::with_config_file(path)` adds `-F path`.
    - `with_program(path)` exists only for the fake-ssh test (`#[cfg(test)]`).
  - `pub async fn connect(config: &EndpointConfig, local, expected) -> Result<SshSession>` becomes `statglass_session::connect(&OpenSshDialer::default(), &config.endpoint(), local, expected)`.
  - Remove the old `dial`, `race_routes`, `combine` and `stderr_error` once their logic lives in the seam.
  - `crates/statglass-remote/tests/docker_openssh.rs` (`#[ignore]`) runs the three conformance functions with `OpenSshDialer::with_config_file($STATGLASS_SSH_DOCKER_SSH_CONFIG)` and alias `statglass-docker`.
- Behavior:
  - `connect` validates, then dials every target at once. Each target gets dial plus handshake under `HANDSHAKE_TIMEOUT`, counted from the dial start.
  - On a handshake failure: `close` the stream, `yield_now`, then `marker_error`, else `dialer.classify`.
  - Identity, negotiation and `HelloAck` work as at `transport.rs:282-304`.
  - Race rules follow the test-case list. One target returns its own error. N failures give `Routes` in target order, or `AgentNotRunning` if any failure is that and all are retryable; a non-retryable failure wins.
  - OpenSSH `dial` spawns `ssh_command(alias)` plus `-oPort`/`-oUser`/`-F` before `--`, captures stderr into `StderrTail`, and returns a `ChildClose`.
  - OpenSSH `classify`: `setup_ssh_error` first, then `TimedOut` → `Timeout`, timeout text → `Timeout`, empty → `Transport(sentence)`, unreachable kinds, else `Transport`. This is today's `stderr_error` minus the marker branch.
  - `host_keys` are ignored (known_hosts with `StrictHostKeyChecking=yes`).
- Decisions already made:
  - A non-retryable failure ends the race (kept from `transport.rs:426-431`).
  - Preference is target order, with grace applied across the whole list.
  - Losers are cancelled by drop, so every `DialedStream` releases on drop.
  - The shared handshake checks only marker lines.
- Out of scope: the russh dialer, `RemoteSource` and promotion (lane a), new markers (phase 5), and manifests.
- Done when: `cargo test -p statglass-session connect`, `cargo test -p statglass-remote transport`, `cargo clippy -p statglass-session -p statglass-remote --all-targets -- -D warnings` and `cargo test -p statglass remote` pass.

#### Lane c brief

- Goal: add the russh dialer and the signer seam in `crates/statglass-ssh`, with hermetic tests against an in-process russh server and a Docker harness that runs the session conformance suite over the Linux agent on both dialers.
- Interface:
  - The scaffold's `RusshDialer`, `RusshConfig`, `Signer`, `SignerError`, `der_to_ssh_signature` and `SoftwareSigner`.
  - `crates/statglass-ssh/tests/support/server.rs`: an in-process russh server on `127.0.0.1:0` with a scripted exec handler (stdout bytes, stderr bytes, exit status, a delayed auth reply) that records the requests it saw and when the TCP connection closed.
  - `crates/statglass-ssh/tests/docker.rs` (`#[ignore]`) runs the three conformance functions over `RusshDialer` with a `SoftwareSigner` loaded from `$STATGLASS_SSH_DOCKER_KEY`.
  - `scripts/ssh-docker/Dockerfile` is `debian:bookworm-slim` plus `openssh-server` and a `statglass` user. `scripts/ssh-docker/run.sh`:
    1. Builds `statglass-agent` inside `rust:1.99-bookworm` with the same named volumes and `CARGO_TARGET_DIR` as `make rust-linux-test` (Makefile:166-167).
    2. Generates a host key and a P-256 client key in a `mktemp` directory and writes `authorized_keys` plus the `ssh -F` config.
    3. Starts the container with sshd published on `127.0.0.1:<random>`, and starts `statglass-agent run --socket <socket>` as `statglass`.
    4. Exports the contract environment variables.
    5. Runs `cargo test -p statglass-ssh --test docker -- --ignored` and `cargo test -p statglass-remote --test docker_openssh -- --ignored`.
    6. Removes the container on exit.
- Behavior:
  - Resolve with `tokio::net::lookup_host((host, port.unwrap_or(22)))` (getaddrinfo, so NAT64 works). Never parse literals.
  - Connect addresses in order under `connect_timeout`.
  - Check the server key by algorithm and `SHA256:` fingerprint against `host_keys`: any match passes, otherwise `HostKey("{host}: host key does not match the paired key ({fp})")`.
  - Authenticate with public key through an adapter from `Signer` to russh's signer trait (SEC1 to the `ecdsa-sha2-nistp256` public key; DER to the mpint `(r, s)` blob).
  - Open a session channel and send a single `exec` of `endpoint.command.serve_command()?`; no PTY, env or forwarding.
  - Pump stdout into the reader (a duplex), stderr (ext 1) into `StderrTail`, and EOF/close/exit-status into reader EOF. The writer is the channel writer.
  - `Close`: send channel EOF, disconnect `ByApplication`, wait at most 1 s for the session task, then abort.
  - Drop, of the dial future or the stream: the handle and the session task are dropped and aborted, so TCP closes.
  - Error mapping:
    - Lookup failure → `Unreachable{NameNotResolved}`.
    - `ECONNREFUSED` → `Unreachable{Refused}`.
    - `EHOSTUNREACH`/`ENETUNREACH`/`EHOSTDOWN` → `Unreachable{NoRoute}`.
    - Connect timeout → `Timeout`.
    - Auth rejected, or a signer error → `Authentication`.
    - Exec refused → `Transport`.
    - Every message is prefixed with `"{host}: "`.
  - `classify`: `TimedOut` → `Timeout`, else `Transport` with the stderr tail or `sentence()`.
  - Keepalive is 15 s with at most 3 misses.
- Decisions already made:
  - P-256 is the only key type in 1.0.
  - The signer returns DER, so the Secure Enclave and the software key share one path.
  - The Docker tests are `#[ignore]` and run by `make ssh-docker-test`, not the gate.
  - russh is pinned exactly by the scaffold.
  - `SoftwareSigner` exists only for tests and Docker; the simulator's software key is Swift-side (plan Assumptions).
- Out of scope: UniFFI, the phone's key storage, restricted bare-token commands (phase 5), ProxyJump, and manifests (report if a feature is missing).
- Done when:
  - `cargo test -p statglass-ssh` and `cargo clippy -p statglass-ssh --all-targets -- -D warnings` pass.
  - `cargo check --target aarch64-apple-ios-sim -p statglass-ssh` passes.
  - `make ssh-docker-test` reaches the test run. The conformance tests are expected to pass once lanes a and b are merged.

### Phase 3: shared IPC crate, mirror policy and phone session controls

Demo: desktop `make check` and `e2e-perf` unchanged on the extracted producer; a mirror under `MirrorPolicy::phone()` syncs M1 24 h and M15 30 d with no S10 and draws 1h/24h/7d charts from the right tiers.
Depends on: phase 2

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-ipc/, src-tauri/src/error.rs, src-tauri/src/live.rs, src-tauri/src/live/, src-tauri/src/ipc.rs, src-tauri/src/state.rs, src-tauri/src/remote.rs | contracts | | gpt-6.2-sol | pending | | |
| b | M | crates/statglass-session/src/mirror/, crates/statglass-store/src/reader.rs | contracts | | gpt-6.2-sol | pending | | |
| c | M | crates/statglass-session/src/source/ | contracts (includes the dead-route drop on network change, RFC 2.2 and 4.5) | | gpt-6.2-sol | pending | | |

### Phase 4: mobile Rust facade and native bridge

Demo: the app in the simulator, built with the XCFramework, opens a full session to this Mac over russh with a pre-installed key and shows live CPU on a debug screen.
Depends on: phase 3

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-mobile/src/ | contracts | | gpt-6.2-sol | pending | | |
| b | M | apps/mobile/modules/statglass-native/ | contracts | | gpt-6.2-sol | pending | | |
| c | M | apps/mobile/src/transport/ | contracts | | gpt-6.2-sol | pending | | |

### Phase 5: restricted sessions and pairing on hosts

Demo: in Docker, a restricted key's session streams metrics and gets `Unsupported` for `SpaceStart`; `statglass-agent pair` completes a pairing from a test client; the Mac's Settings shows Paired devices.
Depends on: phase 2

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-remote/src/server/, crates/statglass-remote-helper/src/restricted.rs, crates/statglass-agent/src/restricted.rs | contracts | | gpt-6.2-sol | pending | | |
| b | M | crates/statglass-remote/src/authorized_keys/, crates/statglass-remote/src/pairing/, crates/statglass-agent/src/pair.rs | contracts | | gpt-6.2-sol | pending | | |
| c | M | src-tauri/src/pairing/, src/app/routes/dashboard/settings/_components/paired-devices/ | contracts | | gpt-6.2-sol | pending | | |

### Phase 6: phone UI on demo data

Demo: in the simulator, "Try demo hosts" opens the hosts list on `createMockTransport({ scenarios: ["hosts-dashboard"] })` with a Demo marker. A host screen shows the popover card stack, with paging between hosts. Module pages show ranges, a scrubbable chart and events. Settings and the app lock work. Light and dark screenshots are compared against the desktop popover in `/?window=popover&theme=dark` and the dev gallery, with every difference named. The desktop's `bun run check`, `popover-render-counts.spec.ts`, `gallery.spec.ts` and `make e2e-perf` are unchanged.
Depends on: phase 1

Widgets the host screen needs first are what the popover cards use (`src/app/routes/popover/_components/popover-cards.tsx:44-50`):

- `StreamArea` (with `GapBand` and `ChartAnnotation`, which the module pages also use)
- `StackBar`
- `InlineBar` + `MeterTrack`
- `MirrorBars`
- `StatList` (types only; it has no geometry)

`HeatMatrix`, `CoreTiles`, `RingGauge` and `WindowTicks` are not in the popover and stay in the desktop app (guard 1).

Test cases:

- Core models: `streamAreaModel` on `POPOVER_CPU_STREAM` returns the line and area paths, edge dots and dash offset the desktop draws today, asserted as literal strings.
  - A `null` run breaks the line.
  - A one-point run gives one dot and no line.
  - A short series is right-aligned.
  - `yMax <= 0` is treated as 1.
  - `loading` gives no series.
  - `widthPx` 0 gives dash offset 0.
- Core models: `gapBandsModel` clips spans to the window and drops spans outside it. `annotationsModel` drops markers outside the window and lays them out through `layoutMarkers`.
- Core models, bars:
  - `stackBarModel`: all-null segments give `empty`; a zero fraction is left out of the bar but keeps its legend row; fractions are clamped; the aria label is `"label value, …"` unless overridden.
  - `inlineBarModel`/`meterTrackModel`: `null` gives an empty track with no fill; `"none"` gives no track.
  - `mirrorBarsModel`: a `null` sample leaves an empty slot, never a zero-height bar; heights scale to `upMax`/`downMax`.
- Core: models return token refs (`ColorRef`), never CSS strings, and import no React or DOM (Biome).
- Desktop: every existing widget test, `src/app/routes/popover/render-counts.test.tsx`, `tests/e2e/popover-render-counts.spec.ts` and `tests/e2e/gallery.spec.ts` pass with the test files untouched, and `make e2e-perf` stays within `perf-budget.json`.
- Core: `popoverSlots` tests pass from `packages/core/src/popover/`. The desktop `POPOVER_METRICS` equals `[...POPOVER_CARD_METRICS, "self.cpu"]`, in the same order.
- Mobile twins: each twin renders the model's geometry from the shared fixtures (Path `d`, rect sizes, accessibility label). Colors resolve per scheme (light and dark differ for `-ink`). Reduce Motion means no scroll tween.
- Mobile hosts list:
  - One row per demo host, in the phone-settings order, each with name, OS glyph, status text (Live, Connecting, "Offline since 14:02", Needs attention), three headline values and a sparkline.
  - A Demo marker is visible.
  - Pull to refresh calls `retryRemoteHost` for offline hosts and refetches.
  - Tapping a row pushes `/(hosts)/[host]`.
- Mobile host screen:
  - Cards appear in `popoverSlots` order for the host's module states, and the Linux demo host shows its own set.
  - An unavailable module shows one unavailable card.
  - The long-press menu toggles compact density and moves a card up or down, persisted in phone settings.
  - Tapping a card pushes that module's page.
  - The connection pill reads Live / LAN or Tailscale / frame age, from status and `lastFrame`.
  - Reconnecting and offline states dim the values and say so, never freezing silently.
  - Horizontal paging switches hosts and resubscribes.
  - Unmount and app background unsubscribe.
- Mobile module page:
  - The range control (1 h, 24 h, 7 d, 30 d) refetches history with core `historyKeys`.
  - The chart draws history through the StreamArea twin, with gap bands and event markers.
  - Scrubbing shows the value and host-clock time under the finger. Long-press pins it, with a haptic.
  - The events list for the range uses host-clock times and shows the host time zone when it differs.
  - Empty and error states are specific.
- Mobile settings:
  - Hosts: rename, reorder and remove, local to the demo store.
  - This iPhone: placeholder text until pairing.
  - Data: toggles, including live updates and history sync on cellular.
  - Appearance: System, Light, Dark.
  - About.
  - The app lock toggle requires a successful `LocalAuthentication` prompt to enable. When on, foregrounding prompts, and backgrounding covers the app with a blur. With no enrolled biometrics or passcode, the toggle is disabled with the reason.
- Mobile: every interactive element has an accessible role and label, a target of at least 44 pt, and text that scales with Dynamic Type through the shared `Text` roles.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/src/app/demo.tsx, apps/mobile/src/app/(hosts)/index.tsx, apps/mobile/src/app/settings/, apps/mobile/src/data/hosts.ts, apps/mobile/src/hosts/, apps/mobile/src/lock/, apps/mobile/test/hosts/, apps/mobile/test/settings/ | contracts, RFC 1.4 | mobile hosts/settings tests | gpt-6.2-sol | pending | | mobile tests pass; simulator screenshots of the hosts list and settings |
| b | M | packages/core/src/widget-models/stream-area.ts, packages/core/src/widget-models/gap-band.ts, packages/core/src/widget-models/chart-annotation.ts, packages/core/src/widget-models/charts.test.ts, src/app/widgets/stream-area.tsx, src/app/widgets/gap-band.tsx, src/app/widgets/chart-annotation.tsx, apps/mobile/src/widgets/stream-area.tsx, apps/mobile/src/widgets/gap-bands.tsx, apps/mobile/src/widgets/chart-annotations.tsx, apps/mobile/test/widgets/charts/ | contracts, .claude/skills/widget-model/, RFC 4.6 | read-only: src/app/widgets/{stream-area,gap-band,chart-annotation}.test.tsx, src/app/routes/popover/ (tests) | gpt-6.2-sol | pending | | core, desktop and mobile chart tests, gallery e2e and e2e-perf pass |
| c | M | packages/core/src/widget-models/stack-bar.ts, packages/core/src/widget-models/inline-bar.ts, packages/core/src/widget-models/meter-track.ts, packages/core/src/widget-models/mirror-bars.ts, packages/core/src/widget-models/bars.test.ts, src/app/widgets/stack-bar.tsx, src/app/widgets/inline-bar.tsx, src/app/widgets/meter-track.tsx, src/app/widgets/mirror-bars.tsx, apps/mobile/src/widgets/stack-bar.tsx, apps/mobile/src/widgets/inline-bar.tsx, apps/mobile/src/widgets/meter-track.tsx, apps/mobile/src/widgets/mirror-bars.tsx, apps/mobile/src/widgets/stat-list.tsx, apps/mobile/src/cards/ (except types.ts), apps/mobile/test/widgets/bars/, apps/mobile/test/cards/ | contracts, .claude/skills/widget-model/, popover-cards.tsx | read-only: src/app/widgets/{stack-bar,inline-bar,meter-track,mirror-bars}.test.tsx, src/app/routes/popover/ (tests) | gpt-6.2-sol | pending | | core, desktop and mobile bar and card tests, gallery e2e and e2e-perf pass |
| d | M | apps/mobile/src/data/live.ts, apps/mobile/src/data/live-stream.ts, apps/mobile/src/data/history.ts, apps/mobile/src/host/, apps/mobile/src/module/, apps/mobile/test/host/, apps/mobile/test/module/ | contracts, src/app/stores/host-store.tsx, src/app/hooks/use-compact-stream.ts | mobile host/module tests | gpt-6.2-sol | pending | | mobile tests pass; simulator screenshots of the host screen and a module page |

No lane touches the files phase 2 owns (Rust) or phase 5 owns (`src-tauri/src/pairing/`, `src/app/routes/dashboard/settings/`). `apps/mobile/src/transport/` stays phase 4's.

#### Scaffold contracts (phase 6)

Moves and edits to existing files (desktop behavior unchanged):

- `git mv src/app/routes/popover/_lib/card-order.ts{,.test.ts}` to `packages/core/src/popover/`.
- `packages/core/src/popover/series.ts` exports `POPOVER_CARD_METRICS` (today's list minus `self.cpu`) and `POPOVER_CARD_SERIES`. `src/app/routes/popover/_lib/series.ts` keeps `POPOVER_METRICS = [...POPOVER_CARD_METRICS, "self.cpu"] as const` and `POPOVER_SERIES`.
- Repoint `src/app/routes/popover/route.tsx` to the moved card order.
- The pure selectors of `src/app/stores/live-selectors.ts` (`held`, `currentLayout`, `keysOf`, `clusterFreqKey`, `select*`, typed over `HostLive`) move to `packages/core/src/live-selectors.ts`, which also exports `CpuSelection = ReturnType<typeof selectCpu>` and the rest. The desktop file keeps the hooks and re-exports the moved names, so no desktop importer changes.
- Prop data types move to core, and the desktop widgets import them:
  - `StreamAreaData` (today's `StreamAreaProps` minus `overlay` and `ariaLabelledBy`; desktop `StreamAreaProps extends StreamAreaData`)
  - `GapSpan`, `ChartAnnotationProps` data
  - `StackBarData`/`StackBarSegment`
  - `InlineBarData`, `MeterTrackData`, `MirrorBarsData`
  - `StatListData` (minus `valueClassName`)
  - `Accent`, `RampStep`, `SwatchStep` (`src/app/widgets/lib/accent.ts` and `legend.tsx` re-export the types).
- Fixtures move: `POPOVER_CPU_STREAM`, `POPOVER_GPU_STREAM` → `packages/core/src/widget-models/fixtures/charts.ts`; `INLINE_BAR`, `POPOVER_CPU_ROWS`, `MEMORY_STACK`, `POWER_STACK_BAR`, `POWER_STAT_GRID`, `GPU_STAT_GRID`, `BATTERY_STAT_GRID` → `fixtures/bars.ts`. `src/app/widgets/lib/sample-props.ts` re-exports them.
- `packages/core/package.json` adds `d3-scale` and `d3-shape`, pinned to the root's versions.
- `apps/mobile/package.json` adds `expo-local-authentication`, `expo-blur` and `expo-haptics` via `bunx expo install`.
- `bun.lock`.
- `apps/mobile/src/app/_layout.tsx` wraps the existing providers in `PhoneTransportProvider` and `PhoneSettingsProvider`.

New contracts (model functions are stubs that throw "not implemented"):

```ts
// packages/core/src/widget-models/tokens.ts
export type Accent = "cpu" | "cpu-2" | "gpu" | "mem" | "power" | "temp" | "net" | "disk" | "battery";
export type RampStep = 1 | 2 | 3 | 4 | "hatch";
export type SwatchStep = RampStep | "track" | "none";
/** A color by token: the accent in scope when `accent` is absent; `ink` for lines and text. */
export type ColorRef =
  | { kind: "accent"; accent?: Accent; step: 1 | 2 | 3 | 4; ink: boolean }
  | { kind: "hatch"; accent?: Accent }
  | { kind: "token"; name: "track" | "fg-faint" | "fg-muted" }
  | { kind: "css"; value: string }; // StackBarSegment.color (residency); phone twins ignore it

// packages/core/src/widget-models/stream-area.ts
export const STREAM_VIEWBOX_W = 1000;
export interface StreamAreaSeriesModel {
  key: string; opacity: number; filled: boolean; linePath: string; areaPath: string;
  edges: readonly { xFrac: number; y: number }[]; stroke: ColorRef; fill: ColorRef;
  dash: readonly [number, number] | null; weight: number;
}
export interface StreamAreaModel {
  height: number; slots: number; windowMs: number; dashOffset: number;
  series: readonly StreamAreaSeriesModel[]; gaps: readonly GapBandModel[];
  annotations: readonly AnnotationModel[]; ceilingLabel: string | null; windowLabel: string | null;
}
export function streamAreaModel(data: StreamAreaData, size: { widthPx: number }): StreamAreaModel;

// gap-band.ts / chart-annotation.ts
export interface GapBandModel { key: string; leftFrac: number; widthFrac: number; label: string; paused: boolean }
export function gapBandsModel(gaps: readonly GapSpan[], fromMs: number, toMs: number): GapBandModel[];
export interface AnnotationModel { key: string; xFrac: number; row: number; label: string; tone: string }
export function annotationsModel(a: readonly ChartAnnotationData[] | undefined, tEndMs: number, windowMs: number, widthPx: number): AnnotationModel[];

// stack-bar.ts / inline-bar.ts / meter-track.ts / mirror-bars.ts
export interface StackBarModel {
  ariaLabel: string; empty: boolean;
  segments: readonly { key: string; grow: number; color: ColorRef; track: boolean }[];
  legend: readonly { key: string; label: string; value: string; swatch: SwatchStep }[];
}
export function stackBarModel(data: StackBarData): StackBarModel;
export interface MeterTrackModel { fill: number | null; color: ColorRef } // null: empty track
export function meterTrackModel(data: MeterTrackData): MeterTrackModel;
export interface InlineBarModel { label: string; value: string; layout: "stacked" | "row" | "wide"; track: MeterTrackModel | null }
export function inlineBarModel(data: InlineBarData): InlineBarModel;
export interface MirrorBarsModel {
  slots: number; up: readonly (number | null)[]; down: readonly (number | null)[]; // px heights
  upColor: ColorRef; downColor: ColorRef; ariaLabel: string;
}
export function mirrorBarsModel(data: MirrorBarsData): MirrorBarsModel;
```

The precise fields can be adjusted by the lanes if the desktop's current output needs them; any change is reported.

```ts
// apps/mobile/src/data/seam.ts
export type PhoneTransport = Pick<Transport,
  | "listHosts" | "listRemoteHosts" | "onHostsChanged" | "onRemoteHostsChanged" | "getHost"
  | "getCapabilities" | "hostVitals" | "setHostsRecentInterest" | "retryRemoteHost"
  | "subscribeLive" | "queryHistory" | "queryEvents">;
// apps/mobile/src/data/transport-context.tsx (implemented)
export function PhoneTransportProvider(props: { children: ReactNode }): JSX.Element;
export function usePhoneTransport(): PhoneTransport;          // throws if no transport chosen
export function useSetPhoneTransport(): (t: PhoneTransport | null, demo: boolean) => void;
export function useIsDemo(): boolean;
// apps/mobile/src/data/demo.ts (implemented)
export function createDemoTransport(): PhoneTransport;        // createMockTransport({ scenarios: ["hosts-dashboard"] })
// apps/mobile/src/data/phone-settings.ts (implemented; zustand/vanilla, in memory this phase)
export interface PhoneSettings {
  hostOrder: HostId[]; hostNames: Record<HostId, string>; removed: HostId[];
  compact: Record<PopoverCard, boolean>; cardOrder: PopoverCard[] | null;
  appearance: "system" | "light" | "dark"; liveOnCellular: boolean; syncOnCellular: boolean; appLock: boolean;
}
export function usePhoneSettings<T>(select: (s: PhoneSettings) => T): T;
export function usePhoneSettingsActions(): { set(patch: Partial<PhoneSettings>): void };
// apps/mobile/src/data/hosts-list.ts (implemented)
export function useHosts(): UseQueryResult<HostRecord[]>;      // listHosts via hostKeys.list(), ordered, renamed, removed filtered
// apps/mobile/src/ui/text.tsx (implemented)
export type TextRole = "largeTitle" | "title" | "cardTitle" | "cardFigure" | "body" | "label" | "caption";
export function Text(props: TextProps & { role: TextRole }): JSX.Element; // iOS text styles, Dynamic Type
// apps/mobile/src/widgets/colors.ts (implemented)
export function resolveColor(ref: ColorRef, scheme: "light" | "dark", accentInScope?: Accent): string;
// apps/mobile/src/widgets/*.tsx (stubs rendering null) take the core data types:
// StreamArea(StreamAreaData), StackBar(StackBarData), InlineBar(InlineBarData),
// MeterTrack(MeterTrackData), MirrorBars(MirrorBarsData), StatList(StatListData)
// apps/mobile/src/cards/types.ts (implemented) + stub components rendering null
export interface CardChrome { compact: boolean; onOpen(): void; onLongPress(): void }
export interface CpuCardProps extends CardChrome { cpu: CpuSelection; stream: StreamAreaData | null }
export interface MemoryCardProps extends CardChrome { memory: MemorySelection }
export interface GpuCardProps extends CardChrome { gpu: GpuSelection; stream: StreamAreaData | null }
export interface PowerCardProps extends CardChrome { power: PowerSelection; source: PowerSource | null }
export interface NetworkCardProps extends CardChrome { network: NetworkSelection; bars: MirrorBarsData | null }
export interface BatteryCardProps extends CardChrome { battery: BatterySelection }
export interface UnavailableCardProps { module: UiModule; state: ModuleState }
```

Route stubs saying "Not built yet":

- `apps/mobile/src/app/(hosts)/_layout.tsx` (Stack, large titles; implemented)
- `(hosts)/index.tsx` (stub, lane a fills it). The two dynamic routes under `(hosts)/[host]/` (`index.tsx`, `[module].tsx`) are final in the scaffold: one-line re-exports of `HostScreen` from `~/host` and `ModuleScreen` from `~/module`, which the scaffold stubs and lane d implements. No lane edits the route files (the plan graph can't list bracketed paths).
- `settings/_layout.tsx`, `settings/index.tsx`

#### Lane a brief

- Goal: the phone shell around hosts on demo data: the demo entry, the hosts list, settings and the app lock.
- Interface:
  - `app/demo.tsx` calls `setTransport(createDemoTransport(), true)` and replaces the route with `/(hosts)`.
  - `app/(hosts)/index.tsx` is the hosts list.
  - `app/settings/*.tsx` holds the sections: `index`, `hosts`, `device`, `data`, `appearance`, `about`.
  - `src/data/hosts.ts`:
    - `useHostVitals(id)`: `hostVitals`, refetched every 5 s while the screen is focused.
    - `useHostStatus(id)`: from `listRemoteHosts` plus `onRemoteHostsChanged`.
    - `useHostSparkline(id)`: `queryHistory` M1, last 30 min, via core `historyKeys`, refetched every 60 s.
  - `src/hosts/` holds the row components.
  - `src/lock/`: `AppLockGate` wraps the root stack below the providers; scaffold `_layout.tsx` imports it. Add it to the scaffold's layout as a stub, or report it if missing.
- Behavior:
  - Rows show the name (phone rename wins), OS glyph and status:
    - Live: connected.
    - Connecting: retrying with no error.
    - "Offline since HH:MM": `last_seen_ms` in the host clock.
    - Needs attention: a non-retryable `failure_kind`.
  - The three headline values come from `HostVitals` (CPU %, memory %, network rx+tx) through `@core/format`. The sparkline is a compact StreamArea twin.
  - The local mock Mac (`is_local`) is presented as a host like the others.
  - The Demo marker sits in the navigation bar.
  - Pull to refresh refetches and calls `retryRemoteHost` on offline hosts.
  - The empty list shows an explanation with "Try demo hosts" and "Pair with your Mac".
  - The settings Hosts section renames (trimmed, 1 to 64 characters), reorders by drag or up/down buttons, and removes with a confirm sheet. Changes are in the phone-settings store only.
  - This iPhone reads "Available after pairing". Data has the two cellular toggles. Appearance drives `Appearance.setColorScheme`. About shows the app version and protocol range.
  - App lock: enabling requires `authenticateAsync` success. When enabled, foregrounding prompts until success, and `AppState` going `inactive`/`background` shows an `expo-blur` cover. With no enrollment and no passcode (`getEnrolledLevelAsync` is `NONE`), the toggle is disabled with that reason.
- Decisions already made: phone settings are in memory this phase (persistence arrives with pairing); no Docker, disk or alerts; the Diagnostics section is out of scope.
- Out of scope: the host screen, module pages, pairing, `MobileTransport`, and widget internals.
- Done when: `bun run --cwd apps/mobile test -- test/hosts test/settings` and `make mobile-check` pass, with simulator screenshots (light, dark, largest Dynamic Type) of the hosts list and settings attached and compared against `plan/design-system.md`.

#### Lane b brief

- Goal: extract the chart widget models (`StreamArea`, `GapBand`, `ChartAnnotation`) into `packages/core/src/widget-models/`, keep the desktop widgets as thin renderers of them with identical output, and build their React Native twins. Follow the `widget-model` skill, one widget per commit.
- Interface: the scaffold signatures. The desktop `StreamArea` keeps its name and props, calls `streamAreaModel(data, { widthPx })` and maps `ColorRef` through `accentVars`/`rampColor`, so the emitted CSS strings are unchanged. The phone `StreamArea(StreamAreaData)`, `GapBands` and `ChartAnnotations` render with `react-native-svg` from the same model, measuring width with `onLayout`.
- Behavior:
  - The model reproduces `stream-area.tsx:136-198` exactly: viewBox 1000 wide, y clamped with `height-1..1`, right alignment, runs split by `splitGaps`, one-point runs as a dot only, the edge rules, and the dash offset formula.
  - Gaps and annotations come from `gapBandsModel`/`annotationsModel`, extracted from `gap-band.tsx`/`chart-annotation.tsx`.
  - Phone tick motion is a Reanimated `translateX` of one slot over 150 ms, off under Reduce Motion.
  - The phone gradient fill is 0.4 to 0 opacity of the fill color.
  - The ceiling and window labels use the `Text` caption role.
  - The accessibility label is `ariaLabel`.
- Decisions already made:
  - Models take measurable inputs only (no platform enum).
  - Forks go in `packages/core/README.md`.
  - A model does no more work per tick than the component did before.
  - The desktop `overlay`, `useTickScroll`, `useReveal` and `ChartFrame` stay in the desktop.
- Out of scope: bar widgets, cards, module-page scrubbing (lane d composes it), `HeatMatrix`, `CoreTiles`, `RingGauge` and `WindowTicks`.
- Done when:
  - `bun run test -- packages/core/src/widget-models/charts.test.ts src/app/widgets/stream-area.test.tsx src/app/widgets/gap-band.test.tsx src/app/widgets/chart-annotation.test.tsx src/app/routes/popover` passes.
  - `bun run test:e2e --project chromium tests/e2e/gallery.spec.ts tests/e2e/popover-render-counts.spec.ts` and `make e2e-perf` pass, with the before/after numbers reported.
  - `bun run --cwd apps/mobile test -- test/widgets/charts`, `bun run typecheck` and `make mobile-check` pass.

#### Lane c brief

- Goal: extract the bar widget models (`StackBar`, `InlineBar`, `MeterTrack`, `MirrorBars`) the same way, build their twins plus a `StatList` twin, and build the phone's popover cards as presentational components over core selectors.
- Interface: the scaffold signatures. The desktop widgets keep their names and props. Phone twins live in `apps/mobile/src/widgets/`. Card components in `apps/mobile/src/cards/` (`ModuleCard` chrome, `CpuCard`, `MemoryCard`, `GpuCard`, `PowerCard`, `NetworkCard`, `BatteryCard`, `UnavailableCard`) take the scaffold's card props.
- Behavior:
  - The models reproduce today's rules: a null fraction is left out of the bar and keeps its legend row, an all-null stack is an empty track, `"none"` means no track, and a null bar is an empty slot.
  - Card content mirrors `popover-cards.tsx` per card: title, headline value by the headline-value rule, rows, segments and stats from the selection and `@core/format`. Missing values render `MISSING`, never 0.
  - Compact density shows only the header and headline.
  - The chrome has the module accent glow, title, headline, and a chevron. The whole card is one button labelled "<Module>, <headline>". Long-press opens the card menu callback.
  - `UnavailableCard` uses `unavailableText`.
- Decisions already made:
  - The desktop's `popover-cards.tsx` is read-only this phase, and card content is not extracted into core yet (risk 5).
  - `StatList` gets no model (no geometry); its twin renders `StatListData`.
  - Residency `css` colors are ignored on the phone.
- Out of scope: chart widgets, the live store, routes, `HeatMatrix`, `CoreTiles` and `RingGauge`.
- Done when:
  - `bun run test -- packages/core/src/widget-models/bars.test.ts src/app/widgets/stack-bar.test.tsx src/app/widgets/inline-bar.test.tsx src/app/widgets/meter-track.test.tsx src/app/widgets/mirror-bars.test.tsx src/app/routes/popover` passes.
  - The gallery and popover render-count e2e tests and `make e2e-perf` pass.
  - `bun run --cwd apps/mobile test -- test/widgets/bars test/cards`, `bun run typecheck` and `make mobile-check` pass.

#### Lane d brief

- Goal: the host screen and module pages: the phone's live store over the seam, the popover card stack with paging and the connection pill, and module pages with ranges, scrubbing and events.
- Interface:
  - `src/data/live.ts`: `useHostLive<T>(host: HostId, select: (s: HostLive) => T, equal?: (a: T, b: T) => boolean): T`, plus a per-host `zustand/vanilla` store reduced with `reduceLive`, `awaitHistory` and `settleSubscribe`.
  - `src/data/live-stream.ts`: `useCompactStream(host, opts): StreamAreaData | null`, ported from `src/app/hooks/use-compact-stream.ts` using core `seriesWindow`, `niceCeiling` and `live-window`.
  - `src/data/history.ts`: `useModuleHistory(host, module, range)` and `useEvents(host, fromMs, toMs)`, both on core query keys.
  - `src/host/`: pager, header, connection pill, card stack, card menu sheet.
  - `src/module/`: range control, scrubbable chart, events list.
  - Screens: `HostScreen` in `src/host/` and `ModuleScreen` in `src/module/`, mounted by the scaffold's route re-exports under `(hosts)/[host]/`.
- Behavior:
  - Subscribe with `{ series: POPOVER_CARD_SERIES, backfillMs: 60_000 }` while the screen is focused and the app is `active`, and unsubscribe otherwise. Follow the sequence in `src/app/stores/host-store.tsx:270-290`, without `windowLabel` or `document` (use `useFocusEffect` and `AppState`).
  - Cards come from `popoverSlots(moduleStates)`, with module states from `moduleState(caps, null, m)`. They are ordered by `phoneSettings.cardOrder` when set; compact comes from phone settings.
  - The pager is a horizontal `FlatList` with `pagingEnabled` over `useHosts()`, and the URL host stays in sync.
  - The pill reads "Live · LAN 1s", "Reconnecting", or "Offline since HH:MM".
  - A stale or reconnecting stream dims the values to 50% and announces the state.
  - Module page:
    - The range control comes from `RANGE_PRESETS` filtered to 1 h, 24 h, 7 d and 30 d.
    - The chart is the StreamArea twin at 160 pt over the history grid, with gaps and `annotations` from events.
    - The scrub is a gesture-handler Pan using `@core/chart-math` cursor, showing the value and host-clock time.
    - Long-press pins with `Haptics.selectionAsync`.
    - The events list below shows host-clock times, with the host time zone shown when it differs (`@core/host-clock`).
    - Loading, empty ("No events in this range") and error states come from `@core/history-state`/`remote-errors`.
- Decisions already made: thin phone hooks over core, no shared hook package (RFC 4.6 inventory); no hover, Docker, disk or process views; the self-CPU footer and pause button are dropped.
- Out of scope: widget internals, card content, the hosts list, settings, pairing, and `MobileTransport`.
- Done when: `bun run --cwd apps/mobile test -- test/host test/module` and `make mobile-check` pass, with simulator screenshots (light and dark) of the host screen beside the desktop popover (`/?window=popover&theme=dark`) and a module page, every difference named.

### Phase 7: pairing and live hosts in the app

Demo: in the simulator, scan (or paste) the QR from this Mac's "Pair iPhone", approve on the Mac, and land on the hosts list with this Mac live; every RFC section 3 error state reachable from a mock scenario renders its specific message.
Depends on: phase 4, phase 5, phase 6

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/src/app/pair/, apps/mobile/src/pairing/ | contracts | | gpt-6.2-sol | pending | | |
| b | M | apps/mobile/src/connection/, apps/mobile/src/app/(hosts)/_errors/ | contracts | | gpt-6.2-sol | pending | | |

## Log

- 2026-11-24: plan critique (devils-advocate, opus) returned 8 findings; all verified and applied: lane a ownership (lib.rs, ipc.rs, test_biome_rules.py, comment references), collect gating ownership to lane d, `mobile-release` profile for catch_unwind, types/commands/events/constants split, `@core/*` alias on mobile with Metro `resolveRequest`, core move and Biome overrides and lockfile moved into the scaffold, live-stream and native error model, `CommandError` moving to `statglass-ipc` in phase 3.
- 2026-11-24: user answers: monorepo per RFC; this run covers RFC phases 0 to 4; restricted scope adds live processes only; accept RFC defaults and section 10 decisions.
- 1/d reported (8b52200). Accepted choices: `version()` returns the desktop envelope with `BuildInfo { version, protocol_min, protocol_max }`, a panic maps to `{kind:"internal"}`; one `target_vendor = "apple"` clock constant; collect `counters`/`net` gated to macOS or Linux; uniffi `default-features = false` with bindgen behind a `bindgen` feature; Swift bindings in library mode with `module.modulemap` in the XCFramework; both iOS targets in deny.toml. check-lane manifest flags expected for this lane. Size spike: `libstatglass_mobile.a` 37.5 MB unstripped; a minimal app strips to 0.40 MB (-dead_strip). LTO drops the engine because `version()` doesn't use it, so the engine's real size is measured again in phase 4. `make rust-linux-check` could not run locally (no x86_64-linux-gnu-gcc); Linux CI covers it.
- 1/d lane review: one finding (generated Swift dir not cleared, not ignored); fixed in 10a5d0ed, ignore entries routed to lane b. Merged.
- 1/c reported (9aa7d5cb). Accepted choices: D-140 to D-149 for RFC decisions 1 to 10, D-150 for the host support window; plain bullets in D-entries; mobile hook blocks any relative import leaving apps/mobile; Stop formatter covers packages/ and apps/mobile/; skill commands use `bun run --cwd apps/mobile`. Also fixed a pre-existing hook bug (core `~/` imports were never blocked). Leftover outside its files: `.claude/commands/statglass:test.md` example path, fixed inline at the phase gate.
- 1/a reported (bf15a0c0). Accepted choices: tauri-specta rc.25 exports one file, so `export_bindings` splits it at the generator's section comments with a named error on a missing or reordered section, and two Rust tests cover it (split code stays in lib.rs, under the size limit); `ConnectionGifTheme` core union mapped to `GifTheme` through the existing prop assignment, so tsc catches drift; `src/app` and widgets ban all of `@desktop/commands`, widgets ban `@desktop/**`; core-test globals exemption needs the rule off and the list cleared for Biome `--only`. Playwright chromium 296/296, bun run check 2797 tests.
- 1/c lane review: 3 findings, all verified and sent back: mobile-check claimed to run native tests (phase 4 adds `make mobile-native-check`), widgets hook missed `@desktop`, no hook for react-native in the desktop app.
- 1/c fixes landed; merged.
- 1/a lane review: 4 findings, all verified and sent back: split must validate section contents at export time with named errors; restore core restrictions for src/desktop-transport/** in Biome with a probe; move export/split code to src-tauri/src/bindings.rs (added to Owns) with scratch-file cleanup on every path; two stale comments.
- Phase 2 and 6 briefs drafted (Plan agent, opus) and adopted. Decisions on its open questions: russh version and crypto backend are chosen and pinned in the phase 2 scaffold with `cargo info russh`, checked against `make mobile-rust-check` and the Linux cross-check; dead-route drop goes to phase 3 lane c; "a non-retryable failure ends the race" is kept, because a host-key mismatch is a security signal (RFC 2.7) and must not be bypassed by a later target; popover card content stays duplicated between `popover-cards.tsx` and `apps/mobile/src/cards/` in this run and is listed as a follow-up in the final report (card-content models in core).
