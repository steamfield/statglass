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
      src/lib/query-client.ts     createQueryClient (one retry, no focus refetch)
      src/lib/providers.tsx       Providers: one client per app mount, safe area
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
Tag: ios-app-phase-1
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
| a | L | packages/core/src/, packages/core/README.md, src/desktop-transport/, src/app/, src/main.tsx, tests/, src-tauri/examples/export_bindings.rs, src-tauri/src/lib.rs, src-tauri/src/bindings.rs, src-tauri/src/ipc.rs, tsconfig.base.json, tsconfig.json, tsconfig.test.json, vite.config.ts, vitest.config.ts, vitest.setup.ts, playwright.config.ts, biome.json, Makefile, .pre-commit-config.yaml, docs-site/tsconfig.json, docs-site/AGENTS.md, scripts/architecture/test_biome_rules.py, scripts/rename-statglass.py, scripts/test-rename-statglass.py | contracts, plan/rfc-ios-app.md 4.3 and 4.6 | existing suites | opus | merged | deliver/ios-app-1a | bun run check, bindings-check, Playwright chromium pass |
| b | M | apps/mobile/, scripts/mobile/check.sh, scripts/mobile/single-react.mjs, scripts/mobile/fixtures/, .github/workflows/ci.yml, bun.lock, compat/mobile-protocol.json | contracts, ~/Projects/stacks/packages/cli/registry/stacks/mobile-expo/ | apps/mobile/test/ | opus | merged | deliver/ios-app-1b | make mobile-check passes; app boots in simulator |
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
Scaffold: 75460248
Tag: ios-app-phase-2

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
- Docker conformance, over both dialers: `live_session`, `agent_not_running` and `source_syncs_mirror` pass. `source_syncs_mirror` first waits up to 180 s for the agent to export its first M1 page (a cold agent closes its first full minute bucket up to two minutes after start; measured 119 s), then asserts the cursor advances within 60 s.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-session/src/lib.rs, crates/statglass-session/src/codec.rs, crates/statglass-session/src/calls.rs, crates/statglass-session/src/clock.rs, crates/statglass-session/src/mirror.rs, crates/statglass-session/src/mirror/, crates/statglass-session/src/mirror_sink.rs, crates/statglass-session/src/mirror_error.rs, crates/statglass-session/src/pages.rs, crates/statglass-session/src/wire.rs, crates/statglass-session/src/network.rs, crates/statglass-session/src/network/, crates/statglass-session/src/source.rs, crates/statglass-session/src/source/, crates/statglass-session/src/conformance.rs, crates/statglass-session/src/test_support.rs, crates/statglass-remote/src/answering.rs, crates/statglass-remote/src/calls.rs, crates/statglass-remote/src/clock.rs, crates/statglass-remote/src/codec.rs, crates/statglass-remote/src/host_server.rs, crates/statglass-remote/src/lib.rs, crates/statglass-remote/src/mirror.rs, crates/statglass-remote/src/mirror/, crates/statglass-remote/src/mirror_error.rs, crates/statglass-remote/src/mirror_sink.rs, crates/statglass-remote/src/network.rs, crates/statglass-remote/src/network/, crates/statglass-remote/src/pages.rs, crates/statglass-remote/src/server.rs, crates/statglass-remote/src/source.rs, crates/statglass-remote/src/source/, crates/statglass-remote/src/test_support.rs, crates/statglass-remote/src/agent_layout.rs, crates/statglass-remote/tests/linux_agent_qa.rs, src-tauri/src/remote/registration.rs, src-tauri/src/remote_tests.rs, src-tauri/src/remote/setup/linux_tests.rs, scripts/architecture/rust-size-ceilings.txt | contracts, RFC 4.2, 4.5 | moved unit tests, conformance | gpt-6.2-sol | merged | foreman/ios-p2a | `cargo test -p statglass-session -p statglass-remote` and `cargo test -p statglass remote` pass; architecture-check passes |
| b | M | crates/statglass-session/src/connect.rs, crates/statglass-session/src/connect/, crates/statglass-remote/src/transport.rs, crates/statglass-remote/src/transport/, crates/statglass-remote/tests/docker_openssh.rs | contracts, transport.rs | connect/tests.rs, transport tests | gpt-6.2-sol | merged | foreman/ios-p2b | `cargo test -p statglass-session connect` and `cargo test -p statglass-remote transport` pass |
| c | M | crates/statglass-ssh/src/, crates/statglass-ssh/tests/, scripts/ssh-docker/ | contracts, RFC 2.2, 2.7, 3.1, 4.2 | statglass-ssh tests | gpt-6.2-sol | merged | foreman/ios-p2c | `cargo test -p statglass-ssh` passes; `make ssh-docker-test` runs |

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

Demo:
- Desktop `make check`, `make e2e-perf` and `make bindings-check` pass on the extracted producer. The only bindings drift is the scaffold's intentional additions: `TierRequest` `"m15"`, two `RemoteFailureKind` values and two `CommandError` kinds.
- `cargo test -p statglass-ipc` runs the moved live-registry and history tests without Tauri.
- A mirror under `MirrorPolicy::phone(PHONE_MIRROR_HOST_MB)` syncs M1 for 24 h and M15 for 30 d, with no S10. Its 1h, 24h and 7d history pages resolve to M1, M1 and M15.
- `cargo check --target aarch64-apple-ios-sim -p statglass-ipc` passes.

Depends on: phase 2

Code facts this phase relies on (checked 2026-11-24; the RFC's line numbers have drifted, and the actual positions are given here):

**`CommandError` and its conversions**
- `CommandError` is at `src-tauri/src/error.rs:8-123`. Its `From` impls for `RangeError`, `UsageRequestError`, `StoreError` and `HistoryStoreError` are at `error.rs:134-181`, and `pub use statglass_engine::HistoryUnavailableReason` is at `error.rs:132`.
- Other `From` impls into `CommandError`:
  - `RemoteError`: `src-tauri/src/remote.rs:217-248`
  - `AgentInstallError`: `remote.rs:250-269`
  - `AgentBundleError`: `remote.rs:271-281`
  - `SpaceError`: `src-tauri/src/disk_space.rs:18`
  - Docker: `src-tauri/src/docker/error.rs:5,38`
- Once `CommandError` lives in ipc, the orphan rule forces these changes:
  - The `RemoteError`, `SpaceError` and Docker impls move to ipc.
  - `AgentInstallError` belongs to `statglass-remote`, and ipc must never depend on remote, so its impl becomes a src-tauri function.
  - `AgentBundleError` is local to src-tauri and keeps its impl.
- `AgentInstallError` reaches `CommandError` through `?` at:
  - `remote/setup.rs:47,137,181`
  - `remote/setup/linux.rs:159,163-166,357-371`
  - the tests at `remote/setup/linux_tests.rs:399-445`
- `src-tauri/src/query/map.rs:105-120` matches `RemoteError` exhaustively.

**Live producer**
- `src-tauri/src/live.rs` (771 lines, ceiling 750):
  - `LiveFeed` is at 58-82 and `LiveSink` at 85-90.
  - `impl LiveSink for tauri::ipc::Channel<LiveMsg>` (92-99) is the only Tauri type in the producer.
  - Constants are at 103-118, `LiveRequest` at 122-142, and `frame_period_ms` / `effective_min_period_ms` at 145-164.
  - `crate::process_signal::refusals()` is called at line 664.
- `src-tauri/src/live/registry.rs` (600 lines):
  - It imports `crate::windows::WindowVisibilityChanged`, a `tauri_specta::Event` (lines 3, 10, 199, 448).
  - `RecentFeed` and `impl RecentFeed for statglass_remote::RemoteSource` are at 12-20.
  - The public API is at 193-511: `new`, `set_visibility_emitter`, `register_recent_source`, `observe_hosts_recent_interest`, `subscribe`, `set_process_interest`, `window_visible`, `window_closed`, `remove_host`, `replace_host` and `is_visible`.
- The emitter is installed at `windows.rs:33-37` as `(label, WindowVisibilityChanged)`.
- Producer tests:
  - `live/tests.rs` (1581 lines), `live/tests/{pending,protocol,replacement}.rs` and `live/visibility_tests.rs`.
  - `replacement.rs:179,275` use `crate::hosts::HostRegistry`.
  - `protocol.rs:59` uses `CommandError`.
- Live and history types in `src-tauri/src/ipc.rs` (891 lines, tests from 812, ceiling 800):
  - `LiveMsg` is at 115-195, `LiveStatus` at 197-220 and `SubscriptionInfo` at 222-240.
  - `TierRequest` (244-252) has only `Auto`, `S10` and `M1`; there is no M15 variant.
  - `HistoryRequest` is at 254-266, `HistoryPage` at 268-281, and `HistorySeries` / `HistoryPoint` at 283-312.
  - The file imports `crate::process_signal::SignalRefusal` (line 15) and re-exports `crate::live_process::LiveProcess` (line 20).
- Process rows and refusals:
  - `LiveProcess` (`live_process.rs:9-108`) carries `refusal: Option<SignalRefusal>`. Its `select(rows, view, &refusal)` uses `crate::app_quit::live_quit_set`.
  - `live_quit_set(rows: &[ProcessSample]) -> HashSet<(i32, i64)>` is pure (`app_quit.rs:31`).
  - In `process_signal/mod.rs`, the `SignalRefusal` enum is at 86-98, its inherent `by_pid`/`by_process`/`of` methods at 100-131, and `pub fn refusals() -> impl Fn(i32, i64, &str) -> Option<SignalRefusal>` at 133-139. All of this is macOS-only.

**History commands**
- `HistoryRequest::to_query` is at `history/ipc.rs:14-32`, `tier_choice` at 34-40 and `history_page` at 126-149.
- `History::history` is at `history/queries.rs:36-48` and `history_through_now` at 115-121.
- In `commands.rs`: `subscribe_live` is at 77-88 (line 88 is `Arc::new(channel)`), `query_history` at 131-145 and `query_events` at 201-214. The ceiling is 700.
- In `state.rs`: `Route` is at 59-63, `LiveRegistry::new()` at 178, `history_for` at 241-247 and `route` at 272-274. The ceiling is 600.

**Remote host status**
- In `src-tauri/src/remote/contracts.rs`: `RemoteState`, `RemoteRoute`, `RemoteSync` and `RemoteFailureKind` are at 13-53, `RemoteRouteFailure` at 55-58, and `RemoteHostStatus` at 59-93.
- `RemoteHostStatus` cannot move to ipc as a whole:
  - It carries `rr: Option<statglass_remote::rr::RrJob>` and `vitals`.
  - `connection_status` (`registration.rs:239-296`) calls the desktop-only `super::commands::agent_update`.
  - `map_route` and `map_failure_kind` are at `registration.rs:298-330`.
- `remote/vitals.rs` (294 lines) builds `HostVitals` from a `LiveFrame`. It is called at `remote/commands.rs:27,42` and re-exported at `remote.rs:372`.

**Session crate**
- `crates/statglass-session/src/source.rs` (about 983 production lines, ceiling 1000):
  - `ControlState` is at 34-41.
  - `network_changed` (123-126) only bumps a counter.
  - Thread-per-source `start` is at 135-158 and `run` at 160-251. The outer `select` at 203-206 cancels a session mid-await on stop or sleep.
  - `session_loop` is at 261-366, with tiers hardcoded at 319: `[Tier::S10, Tier::M1, Tier::M15]`.
  - `request_sync` is at 419-478.
  - `control_changed` is at 480-519: promotion at 488-503, and the sync reset on detail start at 510-515.
  - The ingest `spawn_blocking` is awaited inline at 761-771.
  - `tick` is at 886-972. A Ping goes out every 15 s, and the session drops after a Ping has waited 30 s (897-917), so a dead session can wait about 45 s.
- `source/recent.rs:4-19`: recent rows wait until `next_tier >= tiers.len()`, meaning all sync is done.
- `source/control.rs:41-47`: `stop` joins the thread.
- `source/status.rs`: `ConnectionFailureKind` is at 10-29, its priority at about 40-58, `most_actionable` at 61-67 and `from_error` at 71-98.
- `network.rs`: `LocalNetwork { online, tailscale_up }` is at 6-14, plus `UNKNOWN_NETWORK`. `probe` is at 99-108 and `refine` at 136-155. Nothing tells cellular apart from LAN.
- `mirror.rs`:
  - `recent_watermark` is the end of durable S10 data (44-46), and `recent` accepts S10 only (124).
  - `enforce_budget` / `prune` are at 194-218. They use `Retention::mirror_default()` with `max_bytes = budget * 1_000_000`.
  - `Mirror::new(history, host, budget: u32)` is at 225-237; the budget is in MB.
- `mirror_sink.rs:10-57` is the `MirrorSink` trait. Its default `history_floor` (50-56) is S10 1 d, M1 7 d, everything else 30 d.
- `connect.rs:145-151` combines failures into `AgentNotRunning` when every failure is retryable.
- `dialer.rs:108-117` holds `AGENT_NOT_RUNNING` and `marker_error`.

**Store crate**
- `crates/statglass-store/src/types.rs`:
  - `TierChoice { Auto, Fixed(Tier) }` is at 131-136.
  - `Retention` is at 185-201, with `MIRROR_MAX_BYTES` = 100 MB, and `mirror_default` at 209-214.
- `reader.rs`: the `TierChoice` match is at 203-206, `auto_tier_for` / `auto_tier` at 263-286, `s10_covers` at 288-299 and `history_recent` at 630-638. The ceiling is 850.
- `reader/export.rs:95-96` also matches `TierChoice`.

**Size checker**
- `rust_size.py` fails a ceiling entry when the file is at 500 lines or fewer, or missing.

Test cases:

**Boundary**
- `statglass-ipc`'s normal dependencies are exactly schema, store, engine and session (architecture-check).
- A negative fixture proves `statglass-ipc -> statglass-remote` is rejected.
- `cargo check --target aarch64-apple-ios-sim -p statglass-ipc` passes. The engine-service `From` impls are compiled out on iOS.

**Desktop unchanged**
- `make bindings-check`: the only drift is the scaffold's additions. Every moved type keeps its name, doc comments and serde shape. `bun run typecheck`, `bun run test` and `make e2e-perf` pass.
- `CommandError` JSON is byte-identical for every existing kind. The tests `store_errors_map_to_typed_command_errors` and `unavailable_reasons_say_why` pass from ipc, unchanged.
- `RemoteError` maps the same as before: `AgentNotRunning` → `remote_agent_not_running`, `Routes` → `remote_unreachable`. The new `AppNotRunning` maps to `remote_not_running` and `MonitoringOff` to `remote_monitoring_off`.
- The Linux setup tests pass through `agent_install_error`, and each variant produces the same JSON as the old `From` impl.
- `RemoteHostStatus` JSON is identical for a fixture that covers every field. The snapshot is written before the move.
- The live producer behind `TauriSink` passes the existing `live/tests.rs` assertions from ipc: subscribe, frame period, coalescing, process interest, replacement and visibility.
- The replacement tests that use `HostRegistry` pass in src-tauri.
- `WindowVisibilityChanged { visible }` still reaches the webview through the `Fn(&str, bool)` emitter.
- `LiveRegistry::with_refusals(DesktopRefusals)` refuses a `kernel_task` row with `kernel_task`, as today. `LiveRegistry::new()` gives `refusal: None` on every row.
- `query_history` with `Auto`, `S10` and `M1` returns the same pages as before, compared by fixture equality on a seeded store. `query_events` is unchanged.

**History tiers**
- `TierRequest::M15` maps to `TierChoice::Fixed(M15)`. The mock `exportTier` handles `"m15"`.
- With `TierChoice::Covered { s10_ms: None, m1_ms: Some(24h) }`:
  - 1 h and 24 h ranges resolve to M1, and 7 d resolves to M15.
  - No range resolves to S10.
- With both fields `None`, every range resolves to M15.

**MirrorPolicy**
- `MirrorPolicy::desktop(budget)` reproduces today's numbers: `sync_tiers == [S10, M1, M15]`, the `mirror_sink.rs:50-56` floors, `mirror_default()` retention with the given budget, and `auto_choice == Auto`.
- `MirrorPolicy::phone(PHONE_MIRROR_HOST_MB)` (25):
  - `sync_tiers == [M1, M15]`, with M1 floor `now − 24 h` and M15 floor `now − 30 d`.
  - Retention prunes M1 older than 24 h and M15 older than 30 d, with `max_bytes = 25_000_000`.
  - `auto_choice == Covered { s10_ms: None, m1_ms: Some(24h) }`.
- `PHONE_MIRROR_HOST_MB == 25` and `PHONE_MIRROR_TOTAL_MB == 250` (RFC 5).
- A source over a phone mirror never sends an S10 `SyncRequest`; a fake host records every request.
- On a phone mirror, `recent_watermark` and `recent` use M1, the finest tier kept.

**Source: sync policy and recent rows**
- `SyncPolicy::Off` sends no `SyncRequest`, and live frames still flow. `SummaryOnly` syncs only the last tier.
- `set_sync_policy(Full)` after `Off` starts sync without reconnecting.
- When `sink.recent_first()` is true, starting the detail view sends `RecentRequest` before the first sync page, and recent rows are not held until sync completes.
- The desktop sink returns false, so its order is unchanged.

**Source: runtime, quiesce and resume**
- `SourceOptions { runtime: Some(handle) }` spawns a task, not a thread, and `stop()` does not join. This is tested on a current-thread runtime with paused time.
- `quiesce()` during an ingest `spawn_blocking` resolves only after the ingest commits:
  - The cursor equals the last page.
  - The fake host sees EOF.
  - Nothing is cancelled mid-ingest.
- When idle, `quiesce()` resolves within 5 s, and no dial happens until `resume()`.
- `resume()` dials once, immediately, with the backoff reset.

**Dead-route drop**
- On a Tailscale session, `network_changed(LocalNetwork { tailscale_up: false, .. })` drops the session immediately and redials.
- On a LAN session, `lan_up: false` (cellular only) also drops immediately.
- If the route class is still up but the network changed:
  - An immediate Ping goes out.
  - No Pong within `NETWORK_CHANGE_PROBE` (5 s) drops the session.
  - A Pong keeps it, and the phase 2 promotion runs.
- `UNKNOWN_NETWORK` never drops a session.
- `summarize`: interfaces `pdp_ip0` plus `utun3` (100.x) give `lan_up: false, tailscale_up: true`. Adding `en0` with a private v4 address gives `lan_up: true`.

**Markers**
- A stderr line `statglass-remote-helper: not running` gives `AppNotRunning`, and `statglass-remote-helper: remote monitoring off` gives `MonitoringOff`, whichever dialer is used.
- `ConnectionFailureKind::from_error` maps both.
- When every failure is retryable, the race combine prefers `MonitoringOff` > `AppNotRunning` > `AgentNotRunning`.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-ipc/src/live.rs, crates/statglass-ipc/src/live/, crates/statglass-ipc/src/history.rs, crates/statglass-ipc/src/history/, crates/statglass-ipc/src/vitals.rs, crates/statglass-ipc/src/status.rs, crates/statglass-ipc/src/process.rs, src-tauri/src/live.rs, src-tauri/src/live/, src-tauri/src/live_host_tests.rs, src-tauri/src/ipc.rs, src-tauri/src/state.rs, src-tauri/src/commands.rs, src-tauri/src/windows.rs, src-tauri/src/live_process.rs, src-tauri/src/app_quit.rs, src-tauri/src/process_signal/, src-tauri/src/history/ipc.rs, src-tauri/src/history/queries.rs, src-tauri/src/remote/contracts.rs, src-tauri/src/remote/vitals.rs, src-tauri/src/remote/registration.rs, src-tauri/src/remote/commands.rs, src-tauri/src/hosts.rs, scripts/architecture/rust-size-ceilings.txt | contracts, RFC 4.4 | moved live/history tests, `RemoteHostStatus` snapshot | gpt-6.2-sol | pending | | `cargo test -p statglass-ipc -p statglass`, `make bindings-check` (scaffold drift only), `bun run typecheck`, `make e2e-perf` and `make architecture-check` pass; `cargo check --target aarch64-apple-ios-sim -p statglass-ipc` passes; `git diff -M --stat` shows the moves as renames |
| b | M | crates/statglass-session/src/mirror.rs, crates/statglass-session/src/mirror/, crates/statglass-session/src/mirror_policy.rs, crates/statglass-store/src/reader.rs, crates/statglass-store/src/reader/, crates/statglass-store/tests/covered_tier.rs, crates/statglass-ipc/tests/phase3_gate.rs | contracts, RFC 4.3, RFC 5 | mirror policy, `Covered` resolution, phase gate | gpt-6.2-sol | pending | | `cargo test -p statglass-session mirror`, `cargo test -p statglass-store` and `cargo test -p statglass-ipc --test phase3_gate` pass; clippy clean |
| c | L | crates/statglass-session/src/source.rs, crates/statglass-session/src/source/, crates/statglass-session/src/network.rs, crates/statglass-session/src/network/, crates/statglass-session/src/connect.rs, crates/statglass-session/src/connect/, crates/statglass-session/src/dialer.rs | contracts, RFC 2.2, 4.5 | source tests under paused time | gpt-6.2-sol | pending | | `cargo test -p statglass-session` and `cargo test -p statglass remote` pass; `make architecture-check` passes with `source.rs` at or under its ceiling |

Lane a owns `rust-size-ceilings.txt`. Lane c keeps `source.rs` within its 1000-line ceiling by extracting into `source/*.rs`. If the file drops to 500 lines or fewer, lane c reports it, and the ceiling entry is removed when lane a merges.

#### Scaffold contracts (phase 3)

The scaffold also runs `make bindings`, `make agent-config` and `make deny`.

Edits to existing files:

**Crate setup**
- `Cargo.toml`: add workspace member and dependency `statglass-ipc`. Update `Cargo.lock`.
- `src-tauri/Cargo.toml`: add `statglass-ipc`.
- `crates/statglass-ipc/Cargo.toml`:
  - Dependencies: schema, store, engine, session, serde, specta (derive), thiserror, tracing, and tokio (`rt`, `sync`, `time`, `macros`; no `process`).
  - Dev-dependencies: serde_json, tokio with `test-util`.
- `scripts/architecture/crate-edges.json`: add `statglass-ipc` → schema, store, engine, session, and add `statglass-ipc` to `statglass`. Add a negative fixture proving `statglass-ipc -> statglass-remote` is rejected.
- `scripts/mobile/check-rust-ios.sh`: add `-p statglass-ipc` to the check and clippy lines.
- `.claude/rules/rust/crates.md` and the CLAUDE.md crate list: add ipc. Its role is the platform-neutral command layer and live producer shared by desktop and mobile, and it never depends on `statglass-remote`, `tauri` or `tauri-specta`.

**`CommandError` move**
- `src-tauri/src/error.rs` becomes `pub use statglass_ipc::error::*;`. Its tests move to ipc.
- `src-tauri/src/remote.rs`:
  - Delete `From<RemoteError>`.
  - Replace `From<AgentInstallError>` with `pub(crate) fn agent_install_error(e: AgentInstallError) -> CommandError`, keeping the same body.
  - Keep `From<AgentBundleError>`.
- Change `?` to `.map_err(agent_install_error)?` at `remote/setup.rs:47,137,181`, `remote/setup/linux.rs:159,163-166,357-371` and in `linux_tests.rs:399-445`.
- `src-tauri/src/disk_space.rs:18` and `src-tauri/src/docker/error.rs:5,38`: delete the impls. They move to ipc under `#[cfg(not(target_os = "ios"))]`.

**Tiers and history**
- `src-tauri/src/ipc.rs:244-252`: add `TierRequest::M15`.
- `history/ipc.rs:34-40`: map `M15` to `TierChoice::Fixed(Tier::M15)`.
- `packages/core/src/mock/queries.ts:360-370`: add an `exportTier` branch for `"m15"`.
- `crates/statglass-store/src/types.rs:131-136`: add `TierChoice::Covered(TierCoverage)`. In `reader.rs:203-206` and `reader/export.rs:95-96`, add the stub arm `TierChoice::Covered(_) => return Err(StoreError::Usage("covered tier choice not implemented".into()))`.

**Mirror and source**
- `crates/statglass-session/src/mirror_sink.rs`: add the trait defaults `fn sync_tiers(&self) -> &[Tier] { &[Tier::S10, Tier::M1, Tier::M15] }` and `fn recent_first(&self) -> bool { false }`.
- `crates/statglass-session/src/mirror.rs`: add `Mirror::with_policy` as a stub that delegates to `new`.
- `crates/statglass-session/src/lib.rs`: declare `pub mod mirror_policy;`. Re-export `MirrorPolicy`, `PHONE_MIRROR_HOST_MB`, `PHONE_MIRROR_TOTAL_MB`, `SourceOptions`, `SyncPolicy`, `NETWORK_CHANGE_PROBE`, `APP_NOT_RUNNING` and `MONITORING_OFF`.
- `crates/statglass-session/src/source.rs`: add the `SourceOptions` and `SyncPolicy` types, plus the `with_options`, `set_sync_policy`, `quiesce` and `resume` stubs below.
- `crates/statglass-session/src/network.rs`: add `lan_up: bool` to `LocalNetwork`. `UNKNOWN_NETWORK` gets `lan_up: true`, and `summarize` sets `lan_up = online` until lane c refines it.

**Marker contract** (here so that phase 5 never edits phase 3 lane files):
- `crates/statglass-session/src/error.rs`: add `RemoteError::AppNotRunning(String)` and `RemoteError::MonitoringOff(String)`. Both are retryable.
- `crates/statglass-session/src/dialer.rs`: add `pub const APP_NOT_RUNNING: &str = "statglass-remote-helper: not running";` and `pub const MONITORING_OFF: &str = "statglass-remote-helper: remote monitoring off";`.
- `source/status.rs`: add `ConnectionFailureKind::{AppNotRunning, MonitoringOff}`, ranked just above `AgentNotRunning`, with `from_error` arms.
- Add new arms to every exhaustive match:
  - In ipc `From<RemoteError>`: `AppNotRunning` → `CommandError::RemoteNotRunning` and `MonitoringOff` → `CommandError::RemoteMonitoringOff`.
  - In `src-tauri/src/query/map.rs:105-120`.
  - In `remote/contracts.rs:13-53`: `RemoteFailureKind::{AppNotRunning, MonitoringOff}`.
  - In `registration.rs:305-330`: `map_failure_kind`.
- The TypeScript switches with a default and the `Partial<Record>` maps in `packages/core/src/remote-errors.ts:100` and `remote-connection*.ts` still compile. They render generic text until phase 5 lane c adds the specific wording.

**ipc modules and the phase gate**
- `crates/statglass-ipc/src/lib.rs` and `error.rs` are scaffold-owned. The scaffold creates the other modules with the types below; lane a moves the existing code into them verbatim.
- `crates/statglass-ipc/tests/phase3_gate.rs` is `#[ignore]` until lane b removes the ignore. It builds a phone `Mirror` over a temp store, then asserts `sync_tiers == [M1, M15]` and that a 7 d `Covered` query resolves to M15.

New public signatures:

```rust
// crates/statglass-ipc/src/lib.rs
pub mod error;   // CommandError and every From<crate error> it needs (scaffold-owned)
pub mod live;    // LiveFeed, LiveSink, LiveRegistry, RecentFeed, LiveMsg/LiveStatus/SubscriptionInfo, LiveRequest
pub mod history; // TierRequest, HistoryRequest/HistoryPage/HistorySeries/HistoryPoint, query_history, query_events
pub mod vitals;  // HostVitals, MemoryPressure, host_vitals
pub mod status;  // RemoteConnection, RemoteState/RemoteRoute/RemoteSync/RemoteFailureKind/RemoteRouteFailure
pub mod process; // LiveProcess, SignalRefusal (data only), RefusalSource, live_quit_set

// crates/statglass-ipc/src/error.rs
pub use statglass_engine::HistoryUnavailableReason;
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommandError {
    // ...every existing variant from src-tauri/src/error.rs:11-122, verbatim...
    /// The other Mac is reachable but StatGlass is not running there.
    #[error("{message}")]
    RemoteNotRunning { message: String },
    /// The other Mac's StatGlass has remote monitoring turned off.
    #[error("{message}")]
    RemoteMonitoringOff { message: String },
}
impl From<statglass_session::RemoteError> for CommandError { /* moved from remote.rs:217-248, plus 2 arms */ }
// #[cfg(not(target_os = "ios"))] From impls for the engine's SpaceError, DockerServiceError and
// DockerStorageError, moved from disk_space.rs:18 and docker/error.rs:5,38 (use their real engine paths).

// crates/statglass-ipc/src/process.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SignalRefusal { KernelTask, Launchd, WindowServer, LoginWindow, #[serde(rename = "statglass")] StatGlass }
/// Per-batch refusal rule. The desktop supplies process_signal's; a phone supplies none.
pub trait RefusalSource: Send + Sync {
    fn batch(&self) -> Box<dyn Fn(i32, i64, &str) -> Option<SignalRefusal> + '_>;
}
pub fn live_quit_set(rows: &[ProcessSample]) -> HashSet<(i32, i64)>; // moved from app_quit.rs:31

// crates/statglass-ipc/src/live.rs
impl LiveRegistry {
    pub fn new() -> Self;                                            // no refusal source
    pub fn with_refusals(refusals: Arc<dyn RefusalSource>) -> Self;
    pub fn set_visibility_emitter(&self, emit: impl Fn(&str, bool) + Send + Sync + 'static);
    // the rest of the API is unchanged from src-tauri/src/live/registry.rs:193-511
}

// crates/statglass-ipc/src/history.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TierRequest { Auto, S10, M1, M15 }
impl HistoryRequest {
    pub fn to_query(&self) -> Result<HistoryQuery, CommandError>;                        // Auto -> TierChoice::Auto
    pub fn to_query_with(&self, auto: TierChoice) -> Result<HistoryQuery, CommandError>; // phone: Auto -> Covered
}
// query_history / query_events take the store, host and request as their desktop callers do
// (commands.rs:131-145, 201-214), plus `auto: TierChoice`. Lane a fixes the exact parameter list
// from the code it moves; the scaffold declares them returning Err(CommandError::Internal { message: "not implemented" }).

// crates/statglass-ipc/src/status.rs
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct RemoteConnection {
    pub state: RemoteState, pub route: Option<RemoteRoute>, pub sync: RemoteSync,
    pub failure: Option<RemoteFailureKind>, pub message: Option<String>,
    pub route_failures: Vec<RemoteRouteFailure>,
}
pub fn connection_status(status: &statglass_session::ConnectionStatus) -> RemoteConnection;

// crates/statglass-store/src/types.rs
pub enum TierChoice { Auto, Fixed(Tier), Covered(TierCoverage) }
/// How far back each fine tier is kept, for a store that keeps less than the desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TierCoverage { pub s10_ms: Option<i64>, pub m1_ms: Option<i64> } // None = tier never kept

// crates/statglass-session/src/mirror_policy.rs
/// RFC 5 defaults for a phone; phase 4's caller enforces the total across hosts.
pub const PHONE_MIRROR_HOST_MB: u32 = 25;
pub const PHONE_MIRROR_TOTAL_MB: u32 = 250;
/// What a mirror keeps and syncs: tiers, floors, retention and the Auto history choice.
#[derive(Clone, Debug, PartialEq)]
pub struct MirrorPolicy { /* private */ }
impl MirrorPolicy {
    pub fn desktop(budget_mb: u32) -> Self;
    pub fn phone(budget_mb: u32) -> Self;
    pub fn budget_mb(&self) -> u32;
    pub fn sync_tiers(&self) -> &[Tier];
    pub fn floor(&self, tier: Tier, now_ms: i64) -> i64;
    pub fn retention(&self) -> Retention;
    pub fn auto_choice(&self) -> TierChoice;
    pub fn recent_first(&self) -> bool; // desktop false, phone true
}
// crates/statglass-session/src/mirror.rs
impl Mirror {
    pub fn with_policy(history: Arc<HistoryStore>, host: HostId, policy: MirrorPolicy) -> Self; // stub: new(history, host, policy.budget_mb())
}

// crates/statglass-session/src/source.rs
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SyncPolicy { #[default] Full, SummaryOnly, Off }
#[derive(Clone, Default)]
pub struct SourceOptions {
    pub runtime: Option<tokio::runtime::Handle>,                    // None = today's dedicated thread
    pub sync: SyncPolicy,
    pub probe: Option<Arc<dyn Fn() -> LocalNetwork + Send + Sync>>, // None = network::probe
}
impl RemoteSource {
    pub fn with_options(record: HostRecord, local: HostId, dialer: Arc<dyn Dialer>, endpoint: Endpoint,
        on_status: StatusCallback, mirror: Option<Arc<dyn MirrorSink>>, options: SourceOptions) -> Arc<Self>; // stub: ignores options
    pub fn set_sync_policy(&self, policy: SyncPolicy); // stub: no-op
    pub fn quiesce(&self) -> BoxFuture<'static, ()>;    // stub: Box::pin(async {})
    pub fn resume(&self);                               // stub: no-op
}
pub const NETWORK_CHANGE_PROBE: Duration = Duration::from_secs(5);
```

#### Lane a brief

- **Goal:** Move the platform-neutral command layer into `statglass-ipc` with no desktop behavior or JSON change, so the phase 4 facade can return the same types. That layer is the live producer, history and events queries, vitals, connection status and process rows.
- **Interface:**
  - Use `git mv` to move:
    - `src-tauri/src/live.rs` and `live/` (registry, effects, tests) to `ipc/src/live*`
    - `live_process.rs` to `ipc/src/process.rs`, together with `live_quit_set`
    - the live and history types from `ipc.rs:115-312`
    - `history/ipc.rs` and the store-only part of `history/queries.rs`
    - `remote/vitals.rs` to `ipc/src/vitals.rs`
    - the enums at `remote/contracts.rs:13-58` to `ipc/src/status.rs`
  - src-tauri keeps thin shims: `pub use statglass_ipc::…` in `ipc.rs`, `live.rs`, `remote/contracts.rs` and `remote/vitals.rs`.
  - Add `pub struct TauriSink(tauri::ipc::Channel<LiveMsg>)` with `impl LiveSink`, used at `commands.rs:88`.
  - `RecentFeed` for `RemoteSource` becomes the newtype `RemoteRecent(Arc<RemoteSource>)` in src-tauri, because of the orphan rule.
  - In `process_signal`, the refusal rule becomes the free functions `refusal_by_pid`, `refusal_by_process` and `refusal_of`, plus `pub struct DesktopRefusals` implementing `RefusalSource`. `state.rs:178` uses `LiveRegistry::with_refusals(Arc::new(DesktopRefusals))`.
  - `windows.rs:33-37` emits `WindowVisibilityChanged { visible }` from the `(label, visible)` callback.
  - `registration.rs` calls `statglass_ipc::status::connection_status` and adds the desktop-only fields `vitals`, `rr` and `agent_update` into the flat `RemoteHostStatus`.
  - The replacement tests that need `HostRegistry` (`live/tests/replacement.rs:179,275`) move to `src-tauri/src/live_host_tests.rs`.
- **Behavior:**
  - JSON and live behavior are identical.
  - Write the `RemoteHostStatus` snapshot test before moving anything.
  - Update `rust-size-ceilings.txt` as files shrink: lower or remove the `ipc.rs`, `live.rs` and `state.rs` entries. Prefer splitting over adding ipc entries.
- **Decisions already made:**
  - `CommandError` lives in ipc (done in the scaffold).
  - `AgentInstallError` maps through a src-tauri function.
  - Refusals are injected, not dropped.
  - `RemoteHostStatus` stays on the desktop side.
  - ipc never depends on remote, tauri or tauri-specta.
- **Out of scope:** mirror and store internals (lane b), source and network code (lane c), the facade (phase 4), any TypeScript change beyond what `make bindings` regenerates, and manifests.
- **Done when:** the conditions in the table are met.

#### Lane b brief

- **Goal:** Let a mirror keep less than the desktop does (`MirrorPolicy::phone`), and make the store resolve Auto history against what the mirror actually keeps.
- **Interface:**
  - Implement the scaffold's `MirrorPolicy`, the `PHONE_MIRROR_*` constants, `Mirror::with_policy` and `TierChoice::Covered`.
  - `impl MirrorSink for Mirror` returns `policy.sync_tiers()`, `policy.floor(..)` and `policy.recent_first()`.
- **Behavior:**
  - `desktop(budget)` reproduces today's numbers exactly, and `Mirror::new` equals `with_policy(desktop(budget))`.
  - `phone(budget)` uses:
    - tiers `[M1, M15]`, with an M1 floor of 24 h and an M15 floor of 30 d
    - retention with those windows, and `max_bytes = budget * 1_000_000`
    - `auto_choice = Covered { s10_ms: None, m1_ms: Some(24h) }` and `recent_first = true`
  - `recent_watermark` and `recent` use the finest tier the mirror keeps.
  - `Covered` resolution picks the finest tier whose coverage includes the whole range: S10 only if it is `Some` and covers the range (`s10_covers`), then M1, otherwise M15.
  - `history_recent` (`reader.rs:630-638`) and export handle `Covered` the same way.
  - Un-ignore `phase3_gate.rs`.
- **Decisions already made:**
  - Phone values are M1 for 24 h, M15 for 30 d, no S10.
  - The budget is 25 MB per host and 250 MB in total. Both are constants, not settings, and phase 4's caller enforces the total.
- **Out of scope:**
  - Which tiers the source requests (lane c reads `sync_tiers`).
  - The ipc `to_query_with` caller (lane a).
  - Cellular first sync, which is a phase 4 `SyncPolicy` change.
- **Done when:** the conditions in the table are met. If `reader.rs` would exceed its 850-line ceiling, extract into `reader/`.

#### Lane c brief

- **Goal:** Make `RemoteSource` usable on a phone. That means an injectable runtime, sync driven by policy, recent rows first, a clean quiesce and resume for backgrounding, and dropping a dead route immediately on a network change. The lane also recognizes the two new host markers.
- **Interface:** the scaffold's `SourceOptions`, `SyncPolicy`, `with_options`, `set_sync_policy`, `quiesce`, `resume`, `NETWORK_CHANGE_PROBE`, `LocalNetwork::lan_up`, `APP_NOT_RUNNING` and `MONITORING_OFF`.
- **Behavior:**
  - Tiers come from `sink.sync_tiers()`, replacing `source.rs:319`. With no sink, use `[S10, M1, M15]`. `SyncPolicy` filters them, and `SummaryOnly` keeps only the last tier.
  - If `sink.recent_first()`, detail start sends `RecentRequest` before the sync reset at `source.rs:510-515`, and `recent.rs:4-19` no longer waits for sync.
  - With `runtime: Some(h)`, spawn `run` on `h`; `stop` aborts and does not join. With `None`, keep today's thread.
  - `quiesce`:
    - It sets a flag, stops issuing sync and recent requests, and awaits any ingest already running.
    - Then it closes the session and parks.
    - Restructure `source.rs:203-206` so the ingest join is outside the cancellable branch.
  - `resume` clears the flag and resets the backoff.
  - `network_changed(net)`:
    - If the current route class is gone, drop now. Tailscale needs `tailscale_up`, and LAN needs `lan_up`.
    - Otherwise, if the network changed, send a Ping now and drop if no Pong arrives within `NETWORK_CHANGE_PROBE`.
    - `UNKNOWN_NETWORK` never drops a session. The phase 2 promotion runs after a session is kept.
  - `summarize` derives `lan_up` from interfaces other than `pdp_ip*` and `utun*` that carry a private v4, ULA or global v6 address.
  - `probe` is injectable.
  - `marker_error` recognizes both new markers. The `connect.rs:145-151` combine prefers `MonitoringOff` > `AppNotRunning` > `AgentNotRunning` when every failure is retryable.
  - Extract new logic into `source/quiesce.rs`, `source/route_watch.rs` and `source/policy.rs`.
- **Decisions already made:**
  - The 15 s / 30 s heartbeat is unchanged.
  - Cellular counts as LAN-down.
  - The desktop passes `SourceOptions::default()`.
- **Out of scope:**
  - Emitting the markers (phase 5).
  - Facade lifecycle calls and cellular first sync (phase 4).
  - Mirror and store internals, and manifests.
- **Done when:** the conditions in the table are met.

---

### Phase 4: mobile Rust facade and native bridge

Demo: the app in the simulator, built with the XCFramework, opens a full session to this Mac over russh with a pre-installed key and shows live CPU on a debug screen.
Depends on: phase 3

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-mobile/src/ | contracts | | gpt-6.2-sol | pending | | |
| b | M | apps/mobile/modules/statglass-native/ | contracts | | gpt-6.2-sol | pending | | |
| c | M | apps/mobile/src/transport/ | contracts | | gpt-6.2-sol | pending | | |

### Phase 5: restricted sessions and pairing on hosts

Demo:
- **Docker** (`make ssh-docker-test`):
  - A restricted key's session streams live metrics and history sync.
  - `SpaceStart` and `UsageByApp` get `Error{code: Unsupported}`.
  - Any other `SSH_ORIGINAL_COMMAND` exits 2.
- **Linux pairing:**
  - `statglass-agent pair` shows a payload and a code. A test client over russh sends `PairStart`, the terminal shows the device name and code, approval answers it, and the client then streams with its new key while the pairing key stops working.
  - A denied run and an expired run leave no device line.
- **This Mac:**
  - Settings > Remote monitoring > "Pair iPhone" shows a QR.
  - A test client pairs against localhost, and the sheet shows the pending device with Approve and Deny.
  - After approval, Paired devices lists the device with a revoke button.

Depends on: phase 2
The phase 5 scaffold is committed after phase 3's, so phase 5 lanes run concurrently with phase 3 lanes.

Code facts this phase relies on (checked 2026-11-24):

**Host session server**
- `crates/statglass-remote/src/server.rs` has 781 lines, about 442 of them production code.
  - `ServerProvider` is at 19-36.
  - `accept_metrics` checks only `same_uid` (84).
  - `serve_connection` (95-158) writes Hello first (100-101), then reads HelloAck (102-107).
  - `Connection::incoming` (175-268) dispatches messages, with `Message::Request` at 260 and `request()` at 271-276.
  - Today the server has no notion of who connected.
- Answering and queries:
  - `answering.rs` sets `MAX_IN_FLIGHT = 8`. Its `start` (56-82) routes Space start, cancel and clear through the ordered lane.
  - `host_queries.rs` already has an `unsupported()` answer.
- Proto:
  - `crates/statglass-proto/src/query.rs:21-56` holds only usage and `Space*` variants plus `Unknown`.
  - The decided refusals therefore leave no allowed `Query` at all. The restricted allowlist is the set of non-query messages: Interest (including process interest), Subscribe, Ping, SyncRequest and RecentRequest.
  - `message.rs:321` defines `ErrorCode::Unsupported`.
- Wire framing is a u32 big-endian length plus CBOR, with `MAX_WIRE_BYTES` at 1 MiB. `SGSP` is 0x53475350, which is above that cap, so it can never be read as a valid length.

**Control socket**
- In `socket.rs`:
  - `SocketPaths::for_current_user` (27-33) resolves `~/Library/Application Support/com.tryopendata.statglass`.
  - `agent()` (34-42) has no control socket on Linux.
  - `ControlRequest` (44-58) is serde-tagged `operation`. `ControlResponse` (59-72) has `#[serde(default)]` optional fields.
  - `serve_control(path, handler, shutdown)` is at 188. It binds through `bind_private` (owner-only: directory 0700, socket 0600).
  - `control_request(path, request)` is at 260. Both ends cap a request at 10 s (230-231, 261, 277).
  - Because both functions take a path, the Linux one-time pairing socket can reuse them.
- `stdio.rs:11-15` holds `stdio_bridge`.

**Helper and agent binaries**
- `crates/statglass-remote-helper/src/main.rs`:
  - Dispatch is at 26-80, and `serve --stdio` at 42-44.
  - The generic error exit is at 21-24 and the usage error at 73-78.
  - There is no restricted mode and no `SSH_ORIGINAL_COMMAND` handling.
- `crates/statglass-agent/src/cli.rs`: the `Command` enum is at 61-77 and `parse` starts at 106. `lib.rs:109` dispatches `Serve`.
- `daemon.rs:179-191`: `serve` prints `AGENT_NOT_RUNNING` and exits 3.

**Mac app**
- `src-tauri/src/remote/server.rs`: `start` is at 4-72, `control_response` at 74-86, and `control()` at 87-157 matches `ControlRequest`.
- `src-tauri/src/lib.rs`: `collect_commands!` is at 73-138, `collect_events!` at 140, and `remote::start` at 222.

**Session commands and keys**
- `crates/statglass-session/src/command.rs:6-52` defines `RemoteCommand` (untagged `MacHelper(String)`, `Agent{bin, system, socket}`) and `serve_command`.
- The RFC 2.3 line example uses a 6-character uppercase hex device tag (`7F3A2C`) and the comment tag `statglass-mobile:`. RFC 2.4 uses `statglass-pairing:<n>` with `expiry-time="…Z"`.
- No `authorized_keys` module exists. Only `statglass-ssh/src/signer.rs` and `scripts/ssh-docker/run.sh` touch the file: line 39 writes the key, which is mounted read-only and installed with mode 600 at line 47.
- `run.sh` exports variables at 105-109 and runs the tests at 112-113. `Makefile:178-181` holds `ssh-docker-test`.
- `statglass-ssh`'s `Signer` is P-256 only. RFC 2.4's Ed25519 pairing key is amended to P-256 (this phase's D-entry).

**Frontend**
- `packages/core/src/transport/contracts.ts:127` defines `Transport`.
- The settings page is `src/app/routes/dashboard/settings/route.tsx`, with the Remote monitoring panel at 95-108.

Test cases:

**Restricted scope**
- `SessionScope::allows`:
  - Every `Query` variant, `Unknown` included, is false for `Restricted` and true for `Full`.
  - The match is exhaustive with no wildcard, so a new variant does not compile until someone decides on it.
- In a restricted session over the in-process server:
  - Interest with detail and process interest, Subscribe, Ping, SyncRequest and RecentRequest behave exactly as in a full session.
  - Each of `UsageByApp`, `HistoricalUsage`, `UsageProcesses`, `SpaceStart`, `SpaceCancel`, `SpaceClear`, `SpaceLargestFiles`, `SpacePath` and `SpaceSubtree` gets `Error{code: Unsupported}` with no side effect. No scan starts and the ordered lane stays empty.
- Preface:
  - If the first client bytes are `SGSP` + u16 length + `{"scope":"restricted","device":"7F3A2C"}`, the session is restricted.
  - With no preface the session is full, so desktop clients are unchanged.
  - A malformed preface, a bad tag, an unknown scope, or a length over 1 KiB closes the connection before HelloAck.
  - An old server reading a preface fails closed because the length exceeds `MAX_WIRE_BYTES`.
- `DeviceTag::parse` accepts exactly 6 uppercase hex characters. `from_key` takes the first 3 bytes of the SHA-256 of the SEC1 key.

**Forced commands**
- Helper `restricted --device <tag>`:
  - `SSH_ORIGINAL_COMMAND` unset or exactly `serve` bridges, with the preface.
  - `version` and `status` print and exit 0.
  - Anything else exits 2 without bridging: `serve --stdio`, `serve;id`, `serve ` with a trailing space, an empty string, `pair`.
- Agent `restricted --device <tag> [--system|--socket P]` follows the same token table over the agent socket.

**Markers**
- Helper `serve` (both restricted and `--stdio`):
  - If the metrics socket is refused and the control `Status` says `allow_remote_monitoring: false`, it prints the `MONITORING_OFF` marker and exits 3.
  - If control is also unreachable, it prints `APP_NOT_RUNNING` and exits 3.
- The desktop connecting to a Mac where the app has quit shows `app_not_running`.

**Device seen log**
- A restricted connection records `{device, last_seen_ms}`. A full connection records nothing.
- A write failure is logged and never fails the session.

**`authorized_keys`**
- The parser round-trips comments, options, blank lines, CRLF, unknown key types and a missing final newline. Every line without a StatGlass tag is preserved byte for byte.
- Adding a device appends `restrict,command="<abs> restricted --device <tag>" ecdsa-sha2-nistp256 <b64> statglass-mobile:<tag> <name>`.
  - The command path is quoted, and the agent's line includes its `--system` or `--socket` argument.
  - The name is sanitized to `[A-Za-z0-9 ._-]`, at most 32 characters.
- Adding the same key twice is idempotent per tag. Revoking removes only that tag's line.
- Adding the pairing line appends `restrict,expiry-time="YYYYMMDDHHMMZ",command="<abs> pair --nonce <n>" ecdsa-sha2-nistp256 <b64> statglass-pairing:<n>`, always in UTC.
- Writes are atomic in the target's directory and keep 0600 on the file. A missing `~/.ssh` is created at 0700.
- A symlinked `authorized_keys` is followed: the target is edited and the link stays a link.
- A line another writer appended between StatGlass's read and its rename survives, because the file is re-read and merged just before the rename.
- `list_devices` returns `{tag, name, fingerprint}` for `statglass-mobile:` lines only.
- Docker against real sshd:
  - After `add_device`, the key authenticates.
  - A pairing line whose `expiry-time` is in the past is refused by sshd with no StatGlass process running.
  - After a revoke, the key is refused.

**Pairing payload**
- The payload encodes and decodes round-trip: `SGP1:` + base45(CBOR), under 1.2 KB for one host.
- Decoding fails with a typed error on expiry, a wrong version, a bad checksum, or a code that is not 6 characters from the code alphabet.

**`PairingHost` approval**
- `offer` installs the pairing line (default TTL 10 min, expiry in UTC) and returns a payload with a 128-bit hex nonce and a six-character code.
- `start` with a valid nonce returns `Waiting`. `status` then returns `Pending{device_name, model, code}` to the approver and `Waiting` to the polling client.
- `approve`: the next `status` returns `Approved{device, hosts}`. The device line is written, the pairing line is removed, and that happens in this order.
- `deny`: the next `status` returns `Denied`. The pairing line is removed and no device line is written.
- When the TTL passes without a decision, `status` returns `Expired` and the pairing line is removed.
- Single use:
  - A second `PairStart` for the same nonce returns `Error(Used)`, whether it uses the same key or another, while pending or after.
  - An unknown nonce returns `Error(Unknown)`.
- Nothing completes without a host decision: with no `approve` call, `status` never returns `Approved`.

**Forced `pair` side**
- Helper `pair --nonce n` reads one `PairStart` frame and sends `ControlRequest::PairStart`.
- It then polls `PairStatus` every 1 s, each request under the 10 s cap, writing a `Waiting` frame once and then the final frame. It exits 0 on `Approved` and 2 otherwise.
- A control request that times out is retried until the payload expires. It does not fail the pairing.

**Linux interactive pairing**
- `statglass-agent pair --ttl 60` prints the payload text, a Unicode QR and the code, binds `pair-<nonce>.sock` owner-only, and prompts `Approve <name> (<model>), code <ABC123>? [y/N]`.
  - `y` approves. `n`, EOF or the timeout denies or expires.
  - Ctrl-C removes the pairing line and the socket.
- `statglass-agent pair --nonce n`, the forced side, talks to that socket.
- `statglass-agent devices` lists devices with their last-seen time. `statglass-agent devices revoke <tag>` exits 0, or exits 1 for an unknown tag.

**Client `pair()`**
- Over a fake dialer it dials with `RemoteCommand::Restricted{forced: Pair}` and the pairing signer, sends `PairStart`, and waits through `Waiting`.
- On `Approved` it returns the restricted `Endpoint` (targets, pinned host keys, user, `Restricted{forced: Serve}`). On `Denied` or `Expired` it returns a typed error.
- Docker `docker_pair`:
  - Approve path: the client streams a live frame with the device key, and the pairing key gets `Authentication`.
  - Deny path: the client gets `Denied`.

**Mac**
- `pairing_start` refuses with `Pairing{..}` and guidance when remote monitoring is off or Remote Login is off. When `ssh -V` reports below 7.7, it also refuses with guidance.
- Otherwise `pairing_start` builds the bundle:
  - targets: `<LocalHostName>.local` and the Tailscale 100.x address from interfaces
  - host keys from `/etc/ssh/ssh_host_{ed25519,ecdsa}_key.pub`
  - the user `$USER` and the OS
  - then it returns the QR SVG and the code.
- The helper symlink `~/Library/Application Support/com.tryopendata.statglass/bin/statglass-remote-helper` points at the bundled helper after launch.
- A test client pairs against localhost:
  - `pairing_status` goes `Waiting`, then `Pending{device_name, model, code}`.
  - `pairing_approve` writes the line and the status becomes `Paired`.
  - `pairing_deny` makes it `Denied`.
  - Letting the TTL pass makes it `Expired`.
- `paired_devices` merges the device lines with the last-seen log. `revoke_device` removes a line.
- The "Pair iPhone" sheet shows the QR and code, then the pending device with Approve and Deny, then the result.
- The Paired devices list revokes after a confirm.
- The UI is compared by screenshot with the Remote monitoring panel.
- The mock transport mirrors every new command.
- The TypeScript wording:
  - `app_not_running` reads "StatGlass isn't running on <host>".
  - `monitoring_off` reads "Remote monitoring is off on <host>".

**Desktop unchanged**
- `cargo test -p statglass remote` passes.
- Every existing server test passes for a full (no-preface) session.
- Docker conformance still passes on both dialers with the full key.
- `make bindings-check` drifts only by the scaffold's pairing commands and types.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-remote/src/scope.rs, crates/statglass-remote/src/scope/, crates/statglass-remote/src/server.rs, crates/statglass-remote/src/stdio.rs, crates/statglass-remote/src/host_server.rs, crates/statglass-remote/src/device_seen.rs, crates/statglass-remote/src/authorized_keys.rs, crates/statglass-remote/src/authorized_keys/, crates/statglass-remote/tests/restricted.rs, crates/statglass-remote/tests/authorized_keys.rs, crates/statglass-remote/tests/docker_restricted.rs, crates/statglass-remote-helper/src/main.rs, crates/statglass-remote-helper/src/restricted.rs, crates/statglass-remote-helper/src/markers.rs, crates/statglass-agent/src/restricted.rs, crates/statglass-agent/src/daemon.rs, crates/statglass-agent/src/devices.rs, crates/statglass-agent/tests/restricted.rs, crates/statglass-agent/tests/devices.rs | contracts, RFC 2.3, 2.5, 2.6, 3.2 | scope, preface, token table, markers, authorized_keys, Docker restricted and sshd key tests | gpt-6.2-sol | pending | | `cargo test -p statglass-remote -p statglass-remote-helper -p statglass-agent` pass; `make ssh-docker-test` passes `docker_restricted`; clippy clean |
| b | L | crates/statglass-remote/src/pairing.rs, crates/statglass-remote/src/pairing/, crates/statglass-remote/tests/pairing.rs, crates/statglass-proto/src/pairing.rs, crates/statglass-proto/src/pairing/, crates/statglass-session/src/pairing.rs, crates/statglass-session/src/pairing/, crates/statglass-remote-helper/src/pair.rs, crates/statglass-agent/src/pair.rs, crates/statglass-agent/src/pair/, crates/statglass-agent/tests/pair.rs, crates/statglass-ssh/tests/docker_pair.rs | contracts, RFC 2.4 | payload codec, approval state machine with a fake `DeviceKeys`, forced side, agent interactive pair, Docker approve/deny | gpt-6.2-sol | pending | | `cargo test -p statglass-proto -p statglass-remote -p statglass-session pairing` and `cargo test -p statglass-agent pair` pass; `make ssh-docker-test` passes `docker_pair` once lane a is merged |
| c | L | src-tauri/src/pairing.rs, src-tauri/src/pairing/, src-tauri/src/remote/server.rs, src/app/routes/dashboard/settings/route.tsx, src/app/routes/dashboard/settings/_components/paired-devices/, src/desktop-transport/native-pairing.ts, src/desktop-transport/app-transport.ts, packages/core/src/mock/pairing.ts, packages/core/src/remote-errors.ts, packages/core/src/remote-connection.ts, packages/core/src/remote-connection-network.ts, tests/e2e/settings-pairing.spec.ts | contracts, RFC 2.3, 2.4, 2.6, 3.2, plan/design-system.md | src-tauri pairing tests, Vitest panel/sheet/mock, Playwright settings | gpt-6.2-sol | pending | | `cargo test -p statglass pairing`, `bun run typecheck`, `bun run test` and `tests/e2e/settings-pairing.spec.ts` pass; screenshot compared to Remote monitoring |

Lane sizes after the approval change:
- `authorized_keys` and agent `devices` moved from b to a, keeping "what a key may do on a host" together. Lane b is now the pairing protocol alone, with approval.
- Lane b tests `PairingHost` against a fake `DeviceKeys`, so it does not wait for lane a.

Ownership:
- No phase 5 file is owned by a phase 3 lane.
- Phase 5 touches the session crate only in `pairing.rs` / `pairing/` (lane b) and in the scaffold's `command.rs` / `lib.rs`.
- Phase 3 lane a owns `src-tauri/src/remote/{contracts,vitals,registration,commands}.rs`. Phase 5 lane c owns only `remote/server.rs` and `pairing*`.

#### Scaffold contracts (phase 5)

The scaffold is committed after phase 3's scaffold. It runs `make bindings`, `make agent-config` and `make deny`.

**Decision record and manifests**
- `plan/decisions.md`: a new D-entry (the next free number; D-151 as of 2026-11-24) amending RFC 2.4. Both the one-time pairing key and the device key are P-256 (`ecdsa-sha2-nistp256`), because `statglass-ssh`'s `Signer` is P-256 only. The `authorized_keys` pairing line uses `ecdsa-sha2-nistp256`.
- `Cargo.toml` / `Cargo.lock`: workspace dependency `qrcode = { version = "=<X>", default-features = false, features = ["svg"] }`, pinned exactly after `cargo info qrcode`. `p256` is already pinned at `=0.14.0`. base45 is written in-house in proto.
- `src-tauri/Cargo.toml`: add `qrcode`.
- `crates/statglass-agent/Cargo.toml`: add `qrcode` for the Unicode QR.

**Session crate**
- `crates/statglass-session/src/command.rs:6-52`:
  - Add `RemoteCommand::Restricted { forced: ForcedToken }`. `serve_command` returns the bare token, `"serve"` or `"pair"`.
  - Add an arm to every exhaustive match on `RemoteCommand`.
  - Serde stays untagged, so desktop JSON is unchanged.
- `crates/statglass-session/src/lib.rs`: declare `pub mod pairing;` and re-export `ForcedToken` and `pair`.

**Proto and remote crates**
- `crates/statglass-proto/src/lib.rs`: declare `pub mod pairing;`.
- `crates/statglass-remote/src/lib.rs`: declare `pub mod scope; pub mod device_keys; pub mod device_seen; pub mod authorized_keys; pub mod pairing;` and re-export them.
- `crates/statglass-remote/src/device_keys.rs`: new and owned by the scaffold. It is the contract both lanes use, and `DeviceTag` is fully implemented here because it is small.
- `crates/statglass-remote/src/socket.rs:44-72`:
  - Add `ControlRequest::PairStart(PairStart)` and `ControlRequest::PairStatus { nonce: String }`. The wire names are `pair_start` and `pair_status`.
  - Add `ControlResponse.pairing: Option<PairReply>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
- `crates/statglass-remote/src/server.rs`: add the default method `fn device_seen(&self) -> Option<&DeviceSeenLog> { None }` to `ServerProvider`.

**Mac app wiring**
- `src-tauri/src/remote/server.rs:87-157`: add stub arms that answer `pairing: Some(PairReply::Error(PairError::Unavailable))`.
- `src-tauri/src/lib.rs`:
  - Declare `mod pairing;`.
  - Register `pairing_start`, `pairing_status`, `pairing_approve`, `pairing_deny`, `pairing_cancel`, `paired_devices` and `revoke_device` in `collect_commands!` (73-138).
  - Manage `pairing::PairingState` in setup.
- `crates/statglass-ipc/src/error.rs`: add `CommandError::Pairing { message: String }`.
- `src-tauri/src/pairing.rs`: map errors through the functions `pairing_error(PairingError) -> CommandError` and `device_keys_error(DeviceKeysError) -> CommandError`. These are functions rather than `From` impls because of the orphan rule.

**Helper and agent wiring**
- `crates/statglass-remote-helper/src/main.rs`: declare `mod restricted; mod markers; mod pair;` and dispatch `restricted --device <tag>` and `pair --nonce <n>` to the stubs.
- `crates/statglass-agent/src/cli.rs:61-77,106+`:
  - Add `Command::{Restricted { device, system, socket }, Pair { ttl_s }, PairForced { nonce }, Devices, RevokeDevice { tag }}`.
  - `pair` with no `--nonce` is the interactive form. `pair --nonce <n>` is the forced form.
- `crates/statglass-agent/src/lib.rs:109`: dispatch to `restricted::run`, `pair::interactive`, `pair::forced`, `devices::list` and `devices::revoke`.

**Transport and frontend**
- `packages/core/src/transport/contracts.ts:127`: add `pairingStart`, `pairingStatus`, `pairingApprove`, `pairingDeny`, `pairingCancel`, `pairedDevices` and `revokeDevice`.
- The mock transport assembly wires `packages/core/src/mock/pairing.ts`. The scaffold creates it with stubs, and lane c owns it from then on.
- `src/desktop-transport/app-transport.ts` delegates to `native-pairing.ts`. The scaffold creates the stub, and lane c owns both files from then on.

**Docker fixture**
- `scripts/ssh-docker/run.sh`:
  - Generate a restricted P-256 key and append its line, with `restrict,command="<agent> restricted --device 0BADC0 --socket <socket>"`.
  - Make `authorized_keys` a writable copy (0600), because pairing edits it.
  - Name the container `statglass-ssh-docker-$$` and export `STATGLASS_SSH_DOCKER_CONTAINER` and `STATGLASS_SSH_DOCKER_RESTRICTED_KEY`.
  - Run the `--ignored` tests `-p statglass-remote --test docker_restricted` and `-p statglass-ssh --test docker_pair`.
- No new crate edges.

New public signatures:

```rust
// crates/statglass-session/src/command.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForcedToken { Serve, Pair } // the bare SSH_ORIGINAL_COMMAND a forced-command key sends

// crates/statglass-remote/src/device_keys.rs  — the device-key contract shared by restricted serving, pairing and the Mac
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DeviceTag([u8; 3]); // 6 uppercase hex on the wire and in authorized_keys
impl DeviceTag {
    pub fn parse(s: &str) -> Option<Self>;
    pub fn from_key(key: &EcdsaP256Public) -> Self; // first 3 bytes of SHA-256(SEC1)
}
impl std::fmt::Display for DeviceTag { /* "7F3A2C" */ }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EcdsaP256Public(pub [u8; 65]); // SEC1 uncompressed
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairedDevice { pub tag: DeviceTag, pub name: String, pub fingerprint: String }
#[derive(Debug, thiserror::Error)]
pub enum DeviceKeysError {
    #[error("authorized_keys: {0}")] Io(#[from] std::io::Error),
    #[error("authorized_keys: {0}")] Invalid(String),
    #[error("not implemented")] NotImplemented,
}
/// The only way StatGlass adds or removes keys on a host.
pub trait DeviceKeys: Send + Sync {
    fn list_devices(&self) -> Result<Vec<PairedDevice>, DeviceKeysError>;
    fn add_device(&self, key: &EcdsaP256Public, name: &str, command: &str) -> Result<DeviceTag, DeviceKeysError>;
    fn revoke(&self, tag: DeviceTag) -> Result<bool, DeviceKeysError>;
    fn add_pairing(&self, key: &EcdsaP256Public, nonce: &str, expires_ms: i64, command: &str) -> Result<(), DeviceKeysError>;
    fn remove_pairing(&self, nonce: &str) -> Result<bool, DeviceKeysError>;
}

// crates/statglass-remote/src/authorized_keys.rs  — the file-backed DeviceKeys (lane a)
pub struct AuthorizedKeys { /* path */ }
impl AuthorizedKeys {
    pub fn for_current_user() -> Result<Self, DeviceKeysError>;
    pub fn at(path: PathBuf) -> Self;
}
impl DeviceKeys for AuthorizedKeys { /* stubs: Err(DeviceKeysError::NotImplemented) */ }

// crates/statglass-remote/src/scope.rs  — who a connection is and what it may ask (lane a)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionScope { Full, Restricted { device: DeviceTag } }
impl SessionScope { pub fn allows(&self, query: &statglass_proto::Query) -> bool; } // stub: matches!(self, Self::Full)
pub const PREFACE_MAGIC: [u8; 4] = *b"SGSP";
pub const MAX_PREFACE_BYTES: usize = 1024;
pub fn encode_preface(scope: &SessionScope) -> Vec<u8>;
/// Reads a preface if present. Returns the 4 bytes already consumed when they were not the
/// magic, so the frame reader can replay them.
pub async fn read_preface<R: AsyncRead + Unpin>(r: &mut R) -> Result<(SessionScope, Option<[u8; 4]>), ScopeError>;
#[derive(Debug, thiserror::Error)]
pub enum ScopeError { #[error("bad session preface: {0}")] Preface(String), #[error(transparent)] Io(#[from] std::io::Error) }

// crates/statglass-remote/src/device_seen.rs  — last-seen time per restricted device (lane a)
pub struct DeviceSeenLog { /* path */ }
impl DeviceSeenLog {
    pub fn new(path: PathBuf) -> Self;
    pub fn record(&self, device: DeviceTag, now_ms: i64); // logs on failure, never errors
    pub fn read(&self) -> BTreeMap<DeviceTag, i64>;
}

// crates/statglass-proto/src/pairing.rs  — what the QR carries and what the pair command says (lane b)
pub const CODE_ALPHABET: &str = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // six-character code, no 0/O/1/I/L
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleHost {
    pub host_id: HostId, pub name: String, pub os: String, pub user: String, pub port: Option<u16>,
    pub targets: Vec<BundleTarget>, pub host_keys: Vec<BundleHostKey>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleTarget { pub route: BundleRoute, pub host: String }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BundleRoute { Lan, Tailscale }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleHostKey { pub algorithm: String, pub sha256: String }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingPayload {
    pub version: u8, pub host: BundleHost,
    pub pairing_key: [u8; 32], // P-256 private scalar (D-entry above)
    pub nonce: String, pub code: String, pub expires_ms: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairStart { pub nonce: String, pub device_key: Vec<u8>, pub device_name: String, pub model: String }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PairReply {
    /// Sent to the pairing client while the host has not decided.
    Waiting,
    /// Seen only by the host's approver (Mac sheet or the agent's terminal).
    Pending { device_name: String, model: String, code: String },
    Approved { device: String, hosts: Vec<BundleHost> }, // phase 5: hosts == [this host]
    Denied,
    Expired,
    Error(PairError),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum PairError {
    #[error("pairing code already used")] Used,
    #[error("unknown pairing code")] Unknown,
    #[error("pairing unavailable on this host")] Unavailable,
    #[error("invalid pairing data")] Invalid,
}
pub fn encode_payload(p: &PairingPayload) -> String;                             // "SGP1:" + base45(cbor)
pub fn decode_payload(s: &str, now_ms: i64) -> Result<PairingPayload, PairError>; // stub: Err(PairError::Invalid)

// crates/statglass-remote/src/pairing.rs  — the host-side approval state machine (lane b)
pub struct PairingHost { /* keys: Arc<dyn DeviceKeys>, offers: Mutex<HashMap<String, Offer>> */ }
pub struct PairCommands { pub pair: String, pub restricted: String } // command= prefixes; nonce/device are appended
impl PairingHost {
    pub fn new(keys: Arc<dyn DeviceKeys>, commands: PairCommands) -> Self;
    pub fn offer(&self, host: BundleHost, ttl: Duration, now_ms: i64) -> Result<PairingPayload, PairingError>;
    pub fn start(&self, req: &PairStart, now_ms: i64) -> PairReply;  // stub: PairReply::Error(PairError::Unavailable)
    pub fn status(&self, nonce: &str, now_ms: i64) -> PairReply;     // client view: Waiting | final
    pub fn pending(&self, nonce: &str, now_ms: i64) -> PairReply;    // approver view: Pending | final
    pub fn approve(&self, nonce: &str, now_ms: i64) -> Result<PairReply, PairingError>;
    pub fn deny(&self, nonce: &str) -> Result<(), PairingError>;
    pub fn cancel(&self, nonce: &str) -> Result<(), PairingError>;
    pub fn expire(&self, now_ms: i64);
}
#[derive(Debug, thiserror::Error)]
pub enum PairingError { #[error(transparent)] Keys(#[from] DeviceKeysError), #[error("{0}")] Pair(#[from] PairError) }
/// The forced `pair` command on any host: relay PairStart, poll PairStatus every second
/// (each request under the 10 s control cap) until a final reply. Returns the exit code.
pub async fn run_forced<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(stdin: R, stdout: W, control: &Path) -> i32; // stub: 2

// crates/statglass-session/src/pairing.rs  — the phone's side (lane b)
pub async fn pair(dialer: &dyn Dialer, payload: &PairingPayload, pairing_key: Arc<dyn Signer>,
    device_key: &[u8], device_name: &str, model: &str, local: HostId) -> Result<(Endpoint, PairReply), RemoteError>;
// stub: Err(RemoteError::Transport("pairing not implemented".into()))
pub fn endpoint_from_host(host: &BundleHost, command: RemoteCommand) -> Result<Endpoint, RemoteError>;

// crates/statglass-remote-helper/src/{restricted,markers,pair}.rs  — each returns the process exit code
pub fn run(device: &str) -> i32;       // restricted.rs  stub: 2
pub fn serve_or_marker() -> i32;       // markers.rs     stub: 3
pub fn run(nonce: &str) -> i32;        // pair.rs        stub: 2
// crates/statglass-agent/src/{restricted,pair,devices}.rs
pub fn run(device: &str, paths: &SocketPaths) -> anyhow::Result<i32>;                  // restricted.rs  stub: Ok(2)
pub fn interactive(ttl: Duration) -> anyhow::Result<()>;                               // pair.rs        stub: Err(anyhow!("not implemented"))
pub fn forced(nonce: &str) -> anyhow::Result<i32>;                                     // pair.rs        stub: Ok(2)
pub fn list() -> anyhow::Result<()>; pub fn revoke(tag: &str) -> anyhow::Result<bool>; // devices.rs     stubs: Err(anyhow!("not implemented"))

// src-tauri/src/pairing.rs  — the Mac's pairing commands (lane c)
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct PairingOffer { pub nonce: String, pub code: String, pub qr_svg: String, pub text: String, pub expires_ms: JsSafeInt }
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PairingStatus { Waiting, Pending { device_name: String, model: String, code: String }, Paired { device: String }, Denied, Expired, Failed { message: String } }
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct PairedDeviceInfo { pub tag: String, pub name: String, pub fingerprint: String, pub last_seen_ms: Option<JsSafeInt> }
// #[tauri::command] #[specta::specta], all async, all stubs returning Err(CommandError::Pairing { message: "not implemented".into() }):
pub async fn pairing_start(state: State<'_, PairingState>) -> Result<PairingOffer, CommandError>;
pub async fn pairing_status(nonce: String, state: State<'_, PairingState>) -> Result<PairingStatus, CommandError>;
pub async fn pairing_approve(nonce: String, state: State<'_, PairingState>) -> Result<PairingStatus, CommandError>;
pub async fn pairing_deny(nonce: String, state: State<'_, PairingState>) -> Result<(), CommandError>;
pub async fn pairing_cancel(nonce: String, state: State<'_, PairingState>) -> Result<(), CommandError>;
pub async fn paired_devices(state: State<'_, PairingState>) -> Result<Vec<PairedDeviceInfo>, CommandError>;
pub async fn revoke_device(tag: String, state: State<'_, PairingState>) -> Result<bool, CommandError>;
```

#### Lane a brief

- **Goal:** A host serves a key according to the scope sshd's forced command gives it, and StatGlass edits `authorized_keys` safely.
  - Restricted sessions get metrics, sync, recent rows, events and process interest. Every `Query` is refused.
  - The helpers print exact markers when the app is not running or monitoring is off.
  - Agent `devices` lists and revokes devices.
- **Interface:** `scope.rs`, `device_seen.rs`, `authorized_keys.rs` (`impl DeviceKeys`), helper `restricted.rs` / `markers.rs`, agent `restricted.rs` / `devices.rs`, and `ServerProvider::device_seen`.
- **Behavior:**
  - **Server** (`server.rs:95-158`):
    - After writing Hello, call `read_preface`, replay any non-magic bytes, then read HelloAck.
    - Store the scope on `Connection`.
    - At `Message::Request` (line 260), answer a query with `!allows` immediately with `Error{code: Unsupported}`, before it reaches `Answering`.
    - Record device-seen for restricted connections.
  - **Helper `restricted --device`:**
    - Validate the tag.
    - Compare `SSH_ORIGINAL_COMMAND` exactly against `serve`, `version` and `status`. Anything else exits 2 with `statglass-remote-helper: command not allowed`.
    - `serve` connects the metrics socket, writes the preface, then calls `stdio_bridge`.
  - **Markers** (`serve --stdio` and restricted `serve`): if the metrics connect fails, send control `Status` (10 s cap). If monitoring is off, print `MONITORING_OFF`; if control is unreachable, print `APP_NOT_RUNNING`. Exit 3.
  - **Agent `restricted`:** the same token table over its socket, with `--system` and `--socket` baked into its line. An unreachable agent keeps `AGENT_NOT_RUNNING` (`daemon.rs:179-191`).
  - **`AuthorizedKeys`** follows RFC 2.5:
    - Only lines tagged `statglass-mobile:` or `statglass-pairing:` are added or removed. Other lines are preserved byte for byte.
    - Symlinks are followed and the target is edited.
    - Writes are atomic in the target's directory, keeping 0600 on the file and 0700 on `~/.ssh`.
    - An advisory lock on a sibling `.statglass.lock` file, plus a re-read and merge just before the rename.
    - Pairing lines carry a UTC `expiry-time`.
  - **`devices`:** `list` prints tag, name, fingerprint and last seen; `revoke <tag>` removes that line.
  - **Docker tests** in `docker_restricted`:
    - live and sync, the Unsupported refusals, and `serve --stdio` exiting 2;
    - a past `expiry-time` refused by sshd with no StatGlass running;
    - permissions kept after `add_device`;
    - a symlinked `authorized_keys` edited through the link.
- **Decisions already made:**
  - Restricted keys only; no Tailscale SSH mode.
  - Every D-117 query is refused, through an exhaustive match.
  - The helper writes the preface, never the client.
  - The device tag is 6 uppercase hex characters derived from the key.
  - Device and pairing keys are P-256.
- **Out of scope:** pairing (lane b), the Mac UI and control arms (lane c), session-crate classifiers (phase 3 lane c), and manifests.
- **Done when:** the table's Done-when conditions are met.

#### Lane b brief

- **Goal:** Implement RFC 2.4 pairing with host approval:
  - a QR payload
  - a one-time P-256 pairing key with a forced `pair` command
  - a start/poll protocol in which nothing completes until the host approves
  - a Linux one-time socket and terminal prompt
  - the phone's client side
- **Interface:** proto `pairing.rs`, `PairingHost`, `run_forced`, session `pair` and `endpoint_from_host`, helper `pair.rs`, and agent `pair.rs` (`interactive`, `forced`).
- **Behavior:**
  - **`offer`:**
    - Generates the P-256 pairing key, a 128-bit hex nonce and a six-character code from `CODE_ALPHABET`.
    - Installs the pairing line through `DeviceKeys::add_pairing` with a UTC expiry (default TTL 10 min).
    - Returns the payload.
  - **`start`:**
    - Checks the nonce and expiry and binds the offer to the first `PairStart`. Every later `PairStart` gets `Used`.
    - Returns `Waiting`.
  - **`status`** returns `Waiting` until a decision. **`pending`** shows the approver the device name, model and code.
  - **`approve`** writes the device line (`add_device`, command `<restricted> --device <tag>`), then removes the pairing line, then reports `Approved{device, hosts: [this host]}`.
  - **`deny`, `cancel` and expiry** remove the pairing line and write no device line.
  - **`run_forced`:**
    - Reads one CBOR `PairStart` frame using the proto framing and sends `ControlRequest::PairStart` to `control`.
    - Writes `Waiting` once, then polls `PairStatus` every 1 s with each request under the 10 s cap. A timeout is retried until the payload expires.
    - Writes the final reply. It exits 0 on `Approved` and 2 otherwise.
  - **Helper `pair --nonce`** calls `run_forced` with the app's control socket.
  - **Agent `pair` (interactive):**
    - Builds this host's bundle: the hostname, LAN addresses and Tailscale 100.x address from interfaces, host keys from `/etc/ssh`, the OS, and `$USER`.
    - Checks `ssh -V` when it can.
    - Uses `AuthorizedKeys` and calls `offer`.
    - Binds `serve_control` at `$XDG_RUNTIME_DIR/statglass/pair-<nonce>.sock` (fallback `~/.local/state/statglass/`). It is owner-only through `bind_private`, and its handler answers `PairStart`/`PairStatus` from the `PairingHost`.
    - Prints the payload text, a Unicode QR and the code.
    - On `Pending`, prompts approve or deny on the terminal. EOF counts as deny. Timeout and Ctrl-C clean up the line and the socket.
  - **Agent `pair --nonce`** calls `run_forced` against that socket path.
  - **Session `pair`:**
    - Dials the payload's host using `RemoteCommand::Restricted{forced: Pair}` and the pairing signer, checking host keys against the payload.
    - Sends `PairStart` and reads replies until a final one.
    - On `Approved`, returns `endpoint_from_host(.., Restricted{forced: Serve})`.
  - **Docker `docker_pair`:** runs `statglass-agent pair --ttl 60` in the background through `docker exec`, with approve or deny fed on stdin, and covers both paths.
- **Decisions already made:**
  - Both keys are P-256 (D-entry).
  - Nothing completes without host approval, which shows the device name and the code.
  - `PairReply::Waiting` exists.
  - The pairing line is removed on approve, deny, cancel or expiry, and sshd's `expiry-time` removes the need for StatGlass to be running.
  - The agent pairing is local and interactive.
  - base45 is written in-house.
- **Out of scope:**
  - The `authorized_keys` file format and safety (lane a). Test against a fake `DeviceKeys`.
  - The Mac commands and UI (lane c).
  - Bundles of other hosts, "Update from Mac" and `authorize-key` (phase 8).
  - Manifests.
- **Done when:** the table's Done-when conditions are met.

#### Lane c brief

- **Goal:** Add "Pair iPhone" on the Mac:
  - a QR and code
  - the app answering `PairStart` / `PairStatus` over its control socket
  - an approval sheet showing the pending device
  - Paired devices with revoke
  - wording for the two new connection markers
- **Interface:** the scaffold's commands and `PairingState`, the control arms in `remote/server.rs`, the TypeScript `Transport` methods, `native-pairing.ts` and `mock/pairing.ts`.
- **Behavior:**
  - **`PairingState` setup:**
    - It wraps a `PairingHost` over `AuthorizedKeys::for_current_user()`.
    - The restricted and pair commands use the stable symlink `~/Library/Application Support/com.tryopendata.statglass/bin/statglass-remote-helper`, re-pointed at the bundled helper on each launch in `pairing/helper_link.rs`.
  - **`pairing/bundle.rs`:**
    - targets: `scutil --get LocalHostName` plus `.local`, and the Tailscale 100.x address from `getifaddrs`
    - host keys: `/etc/ssh/ssh_host_{ed25519,ecdsa}_key.pub` as SHA-256 fingerprints
    - the user is `$USER`, and the OS is macOS plus its version
  - **`pairing_start` refuses with guidance** (P5-4) when:
    - remote monitoring is off
    - Remote Login is off (detected through `launchctl print system/com.openssh.sshd`, otherwise the message says "check Remote Login")
    - `ssh -V` reports below 7.7
  - Otherwise `pairing_start` calls `offer` and renders the QR SVG with `qrcode`.
  - **Control arms:** `PairStart` maps to `start`, and `PairStatus` maps to `status`.
  - **Approver commands:** `pairing_status` uses `pending`, and `pairing_approve` / `pairing_deny` / `pairing_cancel` map to the host's methods.
  - **`paired_devices`** merges `list_devices` with `DeviceSeenLog`. **`revoke_device`** calls `revoke`.
  - **Settings UI:**
    - A Paired devices section under Remote monitoring (`route.tsx:95-108`) with a list and revoke-with-confirm.
    - A "Pair iPhone" sheet:
      - shows the QR, the code and a countdown
      - polls `pairing_status` every 1 s
      - on `Pending`, shows the device name, model and code with Approve and Deny
      - shows the result
      - closing the sheet cancels
  - **Markers in `remote-errors.ts` / `remote-connection*.ts`:** add `app_not_running` and `monitoring_off`, with retry advice.
  - **Mock:** mirrors every command, with fixture devices and a pending device.
- **Decisions already made:**
  - The QR is rendered in Rust.
  - MagicDNS is not in the bundle.
  - Restricted keys only.
  - Approval happens on the Mac sheet.
  - Errors map through src-tauri functions, because of the orphan rule.
- **Out of scope:**
  - The approval state machine and `authorized_keys` (lanes a and b).
  - Handing other hosts to the phone, the intent log and "Update from Mac" (phase 8).
  - Manifests.
- **Done when:** the table's Done-when conditions are met, plus a screenshot compared against Remote monitoring and `plan/design-system.md`, with every difference named.

---

### Phase 6: phone UI on demo data

Demo: in the simulator, "Try demo hosts" opens the hosts list on `createMockTransport({ scenarios: ["hosts-dashboard"] })` with a Demo marker. A host screen shows the popover card stack, with paging between hosts. Module pages show ranges, a scrubbable chart and events. Settings and the app lock work. Light and dark screenshots are compared against the desktop popover in `/?window=popover&theme=dark` and the dev gallery, with every difference named. The desktop's `bun run check`, `popover-render-counts.spec.ts`, `gallery.spec.ts` and `make e2e-perf` are unchanged.
Depends on: phase 1
Scaffold: 4399bfb8

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
| a | M | apps/mobile/src/app/demo.tsx, apps/mobile/src/app/(hosts)/index.tsx, apps/mobile/src/app/settings/, apps/mobile/src/data/hosts.ts, apps/mobile/src/hosts/, apps/mobile/src/lock/, apps/mobile/test/hosts/, apps/mobile/test/settings/, apps/mobile/test/first-launch.test.tsx, apps/mobile/src/data/transport-context.tsx, apps/mobile/src/data/demo.ts | contracts, RFC 1.4 | mobile hosts/settings tests | gpt-6.2-sol | running | foreman/ios-p6a | mobile tests pass; simulator screenshots of the hosts list and settings |
| b | M | packages/core/src/widget-models/stream-area.ts, packages/core/src/widget-models/gap-band.ts, packages/core/src/widget-models/chart-annotation.ts, packages/core/src/widget-models/charts.test.ts, src/app/widgets/stream-area.tsx, src/app/widgets/gap-band.tsx, src/app/widgets/chart-annotation.tsx, apps/mobile/src/widgets/stream-area.tsx, apps/mobile/src/widgets/gap-bands.tsx, apps/mobile/src/widgets/chart-annotations.tsx, apps/mobile/test/widgets/charts/ | contracts, .claude/skills/widget-model/, RFC 4.6 | read-only: src/app/widgets/{stream-area,gap-band,chart-annotation}.test.tsx, src/app/routes/popover/ (tests) | gpt-6.2-sol | running | foreman/ios-p6b | core, desktop and mobile chart tests, gallery e2e and e2e-perf pass |
| c | M | packages/core/src/widget-models/stack-bar.ts, packages/core/src/widget-models/inline-bar.ts, packages/core/src/widget-models/meter-track.ts, packages/core/src/widget-models/mirror-bars.ts, packages/core/src/widget-models/bars.test.ts, src/app/widgets/stack-bar.tsx, src/app/widgets/inline-bar.tsx, src/app/widgets/meter-track.tsx, src/app/widgets/mirror-bars.tsx, apps/mobile/src/widgets/stack-bar.tsx, apps/mobile/src/widgets/inline-bar.tsx, apps/mobile/src/widgets/meter-track.tsx, apps/mobile/src/widgets/mirror-bars.tsx, apps/mobile/src/widgets/stat-list.tsx, apps/mobile/src/cards/ (except types.ts), apps/mobile/test/widgets/bars/, apps/mobile/test/cards/ | contracts, .claude/skills/widget-model/, popover-cards.tsx | read-only: src/app/widgets/{stack-bar,inline-bar,meter-track,mirror-bars}.test.tsx, src/app/routes/popover/ (tests) | gpt-6.2-sol | running | foreman/ios-p6c | core, desktop and mobile bar and card tests, gallery e2e and e2e-perf pass |
| d | M | apps/mobile/src/data/live.ts, apps/mobile/src/data/live-stream.ts, apps/mobile/src/data/history.ts, apps/mobile/src/host/, apps/mobile/src/module/, apps/mobile/test/host/, apps/mobile/test/module/ | contracts, src/app/stores/host-store.tsx, src/app/hooks/use-compact-stream.ts | mobile host/module tests | gpt-6.2-sol | running | foreman/ios-p6d | mobile tests pass; simulator screenshots of the host screen and a module page |

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
- `(hosts)/index.tsx` (stub, lane a fills it). The two dynamic routes under `(hosts)/[host]/` (`index.tsx`, `[module].tsx`) are final in the scaffold: one-line re-exports of `HostScreen` from `@/host` and `ModuleScreen` from `@/module` (mobile's `@/*` alias for `apps/mobile/src/*`), which the scaffold stubs and lane d implements. No lane edits the route files (the plan graph can't list bracketed paths).
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

### Phase 8: the Mac hands its other hosts to the phone

Demo:
- After pairing with this Mac, the phone also gets the Linux Docker host the Mac monitors. The Mac applies an install intent over its own SSH access, and the phone connects to that host with its own restricted key.
- A host that cannot be handed over is listed with its reason (ProxyJump/ProxyCommand, a literal LAN `HostName`, or no stored host key).
- "Update from Mac" reconciles new and removed hosts.
- A revoke queued while the host is offline supersedes an earlier install when the host comes back.

Depends on: phase 5, phase 7

Briefs, scaffold contracts and test cases are written while earlier phases run. Scope comes from RFC 2.4 steps 4-5, "Building the bundle", "Keeping the list current", the manual-pairing `authorize-key` path, and RFC 2.6:
- a durable per-host intent log, where a revoke supersedes a queued install
- `ssh -G` / `ssh-keygen -F` bundle resolution with handover reasons
- agent and helper `authorize-key` / `revoke-key` for the Mac's intents and for manual pairing
- an "Update from Mac" bundle QR that carries no pairing key
- pending intents shown per host on the Mac
- phone-side reconcile

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-remote/src/ssh_config.rs, crates/statglass-remote/src/ssh_config/, crates/statglass-remote/src/intents.rs, crates/statglass-remote/src/intents/, crates/statglass-remote/tests/intents.rs, crates/statglass-remote/tests/docker_handover.rs, crates/statglass-agent/src/authorize.rs, crates/statglass-agent/tests/authorize.rs, crates/statglass-remote-helper/src/authorize.rs | contracts, RFC 2.4, 2.5, 2.6 | | gpt-6.2-sol | pending | | |
| b | L | src-tauri/src/handover.rs, src-tauri/src/handover/, src/app/routes/dashboard/settings/_components/device-intents/, src/app/routes/dashboard/settings/_components/update-from-mac/, src/desktop-transport/native-handover.ts, packages/core/src/mock/handover.ts, tests/e2e/settings-handover.spec.ts | contracts, RFC 2.4, 2.6 | | gpt-6.2-sol | pending | | |
| c | M | crates/statglass-proto/src/handover.rs, crates/statglass-session/src/handover.rs, crates/statglass-mobile/src/handover.rs, apps/mobile/src/handover/, apps/mobile/src/app/update-from-mac.tsx, apps/mobile/test/handover/ | contracts, RFC 2.4 | | gpt-6.2-sol | pending | | |

None of these files is owned by a lane in phase 3, 5, 6 or 7:
- Phase 5 lane c keeps `src-tauri/src/pairing/`, `paired-devices/` and `route.tsx`. Phase 8's scaffold mounts `device-intents/` and `update-from-mac/` from them.
- Phase 5 lane b keeps `proto/src/pairing*` and `session/src/pairing*`.
- Phase 6 lane a keeps `apps/mobile/src/app/settings/`. Phase 7 keeps `apps/mobile/src/app/pair/` and `apps/mobile/src/pairing/`.
- `crates/statglass-mobile/src/handover.rs` is a new file in phase 4's crate. Phase 4 is finished by then, and phase 8's scaffold registers the module.

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
- Phase 1 gate green after boundary fixes (b6bed68b); tagged ios-app-phase-1 (plain phase-1 is taken by an earlier run; later phases use ios-app-phase-N).
- Phase 2 scaffold landed (495650f, merged on deliver/ios-app). russh =0.65.4 with the ring backend (aws-lc-rs needs CMake; ring already builds in the Linux crate set), p256 =0.14.0, sha2 =0.11.1. Deviations accepted: endpoint/dialer/session split into three session files, implemented with tests; `SshSession::test` behind `conformance`; `HostClock` re-export stays on remote's own clock module until lane a moves clock.rs (lane a switches it); `combine` fills `RouteError.host` empty until lane b deletes it; `RusshDialer` fields carry `#[expect(dead_code)]` that lane c removes. Lane a now also owns `crates/statglass-session/src/lib.rs` (module declarations). `make rust-linux-check` cannot run on this machine (no x86_64-linux-gnu-gcc; libsqlite3-sys fails the same way); the scaffold was checked with clippy in `rust:1.99-bookworm` instead.
- Phase 2 lane a (foreman ios-p2a) q1: `crates/statglass-remote/tests/linux_agent_qa.rs` added to its scope for the `RemoteSource::new` signature migration. The injected-dialer source test goes through the real `connect` and may be `#[ignore = "needs phase 2 lane b connect"]` until lane b lands; remove the ignore at integration.
- Phase 2 lane c (foreman ios-p2c) q1: SSH output ends on EOF/channel close, not exit-status (OpenSSH can send status before the last stderr); `lookup_host` kept, so NAT64 synthesis covers names only, not numeric IPv4 literals (tokio parses literals first) -- known limitation for the final report; cancellation is TCP shutdown + handle drop + pump abort, since russh 0.65.4 exposes no session-task abort.
- Phase 2 lane a review (5 findings): FakeDialer::classify now returns a Protocol error instead of panicking (ccb70f30). Accepted the 90 s M1 readiness wait in `source_syncs_mirror` and recorded it in the test cases. Integration step owned by the orchestrator: when lane b merges, delete the five `#[ignore = "needs phase 2 lane b connect"]` lines in `crates/statglass-session/src/source/dial_tests.rs` and run `cargo test -p statglass-session --features conformance dial_tests`. The phase 2 gate adds `cargo test -p statglass-session --features conformance` so the readiness test runs. Rejected: reverting the `budget_mb` local in `src-tauri/src/remote/registration.rs`, which the new argument needed to stay under clippy's function-length limit.
- Phase 2 lane b review (7 findings, all accepted): items 1-4, 6, 7 sent to Codex as a follow-up on ios-p2b (same-poll race can discard a winning preferred session; drain_stderr untested and its timing assert empty; O_NONBLOCK reliance; read_hello mapping and same-route identity tests). Item 5 is the orchestrator's at integration: after lanes a and b merge, rebuild read_hello/write_ack on crate::codec::read/write_frame and delete connect.rs's MAX_WIRE_BYTES.
- Phase 2 lane c review (11 findings, all accepted): 1-7 and 9-11 sent to Codex as a follow-up on ios-p2c (host-key algorithm preference vs pins, signer self-verify, per-address connect budget, close/cap/forbidden-request test gaps, public-key error text, run.sh cleanup and cwd). Item 8 is the orchestrator's at integration: add `[[test]] name = "docker" required-features = ["software-signer"]` to crates/statglass-ssh/Cargo.toml.
- Phase 2 lane b merged (c9b61628) with its review fixes. Integration (882a9e75): the five dial-test ignores removed (all pass against the real connect); read_hello/write_ack rebuilt on codec::read/codec::write, local MAX_WIRE_BYTES deleted.
- 2026-11-24: phase 2 gate green (Vitest 2797, mobile jest 21, Rust incl. statglass-session conformance 117). `make ssh-docker-test` passes all six tests over RusshDialer and OpenSshDialer; the russh `source_syncs_mirror` took 119 s on a cold agent, so the first-page wait is 180 s. NAT64 synthesis covers names only, not IPv4 literals (follow-up). Tagged `ios-app-phase-2`.
- 2026-11-24: phase 6 lanes dispatched to foreman (ios-p6a..d) from 77dce963. Lane a q1: may add `useOptionalPhoneTransport` to `transport-context.tsx` (deep links with no transport redirect to `/`) and combine existing `remote-*` mock scenarios in `demo.ts`; About shows the app version only, and the protocol range moves to phase 4 (facade build info). Lane d q1: no host time zone on the wire, so module pages show skew-corrected host-clock times in the phone's zone; host time zone display is a follow-up that needs a wire change.
- 2026-11-24: phase 3, 5 and 8 sections drafted by opus against the code. Decisions taken under "accept RFC defaults": cellular first sync is a phase 4 `SyncPolicy` change; phone mirror caps are RFC 5's 25 MB per host and 250 MB total, as constants; RFC phase 3's hand-over of other hosts (intent log, bundle resolution, "Update from Mac") is split into phase 8; the pairing key and the device key are both P-256 (amends RFC 2.4's Ed25519 pairing key, because the phone signer is P-256 only; D-entry in the phase 5 scaffold); pairing needs host approval showing device name and code, per RFC 2.4; "Pair iPhone" with Remote Login off refuses with guidance. Drift found: `RemoteHostStatus` stays in src-tauri (it carries `RrJob`), ipc gets the neutral `RemoteConnection`; the restricted allowlist has no `Query` variant to allow, so restricted sessions accept only Interest, Subscribe, Ping, SyncRequest and RecentRequest; `TierRequest` gains `m15`.
- 2026-11-24: lane 6c q1/q2: `PowerCardProps` gains `battery: BatterySelection | null` (the desktop's combined "Power & battery" card) and `MemoryCardProps` gains `totalBytes: number | null` (`host.info.mem_total_bytes`, as `popover-cards.tsx:124`). Lane d's prop builder passes both at integration. Lane 6d q2: the demo transport needs `autoTick: true`; set at integration (lane a owns `demo.ts`). Lanes 6a and 6d ran `expo run:ios` inside their worktrees; the 1.4 GB gitignored `apps/mobile/ios` broke foreman's change scan (WorktreeInvalid), so the orchestrator deleted it in both and told lane d not to prebuild again.
- 2026-11-24: lane 6a q3: the JS AppState + BlurView cover cannot guarantee the UIKit app-switcher snapshot is covered; the native snapshot cover moves to phase 4 lane b (`apps/mobile/modules/statglass-native/`).
- 2026-11-24: lane 6b q1: mobile has no shared motion tokens or Low Power Mode signal yet (`.claude/rules/mobile/expo.md:61,72` require both). Phase 6 integration adds them (theme-sourced durations plus `expo-battery` low power) and swaps lane b's named tick-duration constant for the token.
- 2026-11-24: lane 6c q3: `BatteryCardProps` gains `source: PowerSource | null` (lane d passes `selectPowerSource`); MirrorBars gets a Reduce Motion-aware tween with named timing constants for the integration swap to motion tokens.
- 2026-11-24: phase 6 lane reviews. 6a (5 findings, all accepted): enabling App Lock double-prompts (gate starts locked while AppState is still `inactive`), `useHostSparkline` signature/offset default, refresh errors unattributed, lock reducer extraction, a missing `@throws`. 6d (5, all accepted): module page blanks every minute (no `placeholderData` hold), battery card `source`, swallowed subscribe/status errors, whole host page re-renders at 1 Hz, `live.ts`/`ScrubbableChart` splits and doc blocks. 6b (4, all accepted; no extra per-tick work found, perf deltas read as noise): Dynamic Type caption scale kept as a measurable model input (documented in `packages/core/README.md`), declared `StreamAreaModel` return type with narrowed color refs, phone gap-caption collision listed as a fork, `stream-area.tsx` twin split into `widgets/lib/`. Integration: lane b's and lane c's Reduce Motion hooks are consolidated into the shared mobile motion module.
