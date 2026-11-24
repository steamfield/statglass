# Plan: StatGlass for iPhone

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.4/shared/scripts/plan_graph.py
Started: 2026-11-24. Timebox: none. Landing branch: deliver/ios-app.
Worktree: /Users/riley/Projects/statglass/.claude/worktrees/deliver-ios-app
Gate: `make check bindings-check mobile-check mobile-rust-check` (time recorded at scaffold). Filtered tests: `bun run test -- <path>` (desktop and packages/core), `bun run --cwd apps/mobile test -- <path>` (mobile, jest-expo), `cargo test -p <crate> <filter>` (Rust). Typecheck: `bun run typecheck`.
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
| a | L | packages/core/src/, packages/core/README.md, src/desktop-transport/, src/app/, src/main.tsx, tests/, src-tauri/examples/export_bindings.rs, src-tauri/src/lib.rs, src-tauri/src/ipc.rs, tsconfig.base.json, tsconfig.json, tsconfig.test.json, vite.config.ts, vitest.config.ts, vitest.setup.ts, playwright.config.ts, biome.json, Makefile, .pre-commit-config.yaml, docs-site/tsconfig.json, docs-site/AGENTS.md, scripts/architecture/test_biome_rules.py, scripts/rename-statglass.py, scripts/test-rename-statglass.py | contracts, plan/rfc-ios-app.md 4.3 and 4.6 | existing suites | opus | pending | | bun run check, bindings-check, Playwright chromium pass |
| b | M | apps/mobile/, scripts/mobile/check.sh, scripts/mobile/single-react.mjs, scripts/mobile/fixtures/, .github/workflows/ci.yml, bun.lock, compat/mobile-protocol.json | contracts, ~/Projects/stacks/packages/cli/registry/stacks/mobile-expo/ | apps/mobile/test/ | opus | pending | | make mobile-check passes; app boots in simulator |
| c | M | CLAUDE.md, AGENTS.md, .agents/, .claude/rules/, .claude/skills/, .claude/hooks/, .claude/delegate.md, .claude/launch.json, scripts/agent-config/, scripts/agent-hooks/, plan/decisions.md, plan/PROGRESS.md, plan/README.md | contracts, plan/rfc-ios-app.md | agent-config, agent-hooks tests | opus | pending | | make agent-config-check agent-config-test agent-hooks-test pass |
| d | M | crates/statglass-mobile/, crates/statglass-engine/, crates/statglass-collect/, Cargo.toml, Cargo.lock, rust-toolchain.toml, scripts/architecture/crate-edges.json, scripts/architecture/crate-edges.jq, scripts/architecture/test_crate_edges.py, scripts/architecture/rust-size-ceilings.txt, scripts/mobile/check-rust-ios.sh, scripts/mobile/build-rust-ios.sh, deny.toml | contracts, .claude/rules/rust/platform.md | cargo tests in owned crates, architecture-test | opus | pending | | make mobile-rust-check, architecture-check, architecture-test, rust-check pass |

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

Demo: `cargo test -p statglass-session` and the desktop remote tests pass on the OpenSSH dialer; the same session tests pass against the Linux agent in Docker on the russh dialer.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-session/src/, crates/statglass-remote/, crates/statglass-remote-helper/, src-tauri/src/remote/ | contracts | | gpt-6.2-sol | pending | | |
| b | M | crates/statglass-ssh/ | contracts | | gpt-6.2-sol | pending | | |

(Briefs written during phase 1. The scaffold adds the `Dialer` trait, `Endpoint` and `DialedStream` in `crates/statglass-session/src/dialer.rs`.)

### Phase 3: shared IPC crate, mirror policy and phone session controls

Demo: desktop `make check` and `e2e-perf` unchanged on the extracted producer; a mirror under `MirrorPolicy::phone()` syncs M1 24 h and M15 30 d with no S10 and draws 1h/24h/7d charts from the right tiers.
Depends on: phase 2

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-ipc/, src-tauri/src/error.rs, src-tauri/src/live.rs, src-tauri/src/live/, src-tauri/src/ipc.rs, src-tauri/src/state.rs, src-tauri/src/remote.rs | contracts | | gpt-6.2-sol | pending | | |
| b | M | crates/statglass-session/src/mirror/, crates/statglass-store/src/reader.rs | contracts | | gpt-6.2-sol | pending | | |
| c | M | crates/statglass-session/src/source/ | contracts | | gpt-6.2-sol | pending | | |

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

Demo: "Try demo hosts" in the simulator opens the hosts list, a host screen with the popover card stack, module pages with ranges, events and settings, all on the mock transport, light and dark, compared against the desktop popover.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/src/app/(hosts)/, apps/mobile/src/hooks/, apps/mobile/src/demo/ | contracts | | gpt-6.2-sol | pending | | |
| b | L | packages/core/src/widget-models/, packages/core/src/popover/, apps/mobile/src/widgets/, src/app/widgets/ | contracts | | gpt-6.2-sol | pending | | |
| c | M | apps/mobile/src/app/(module)/, apps/mobile/src/app/settings/, apps/mobile/src/lock/ | contracts | | gpt-6.2-sol | pending | | |

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
