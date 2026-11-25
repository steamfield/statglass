# Plan: StatGlass for iPhone

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.4/shared/scripts/plan_graph.py
Status: reopened (2026-11-25) for phases 7-10 at the user's request (phase 10 expands to the polish RFC's phases); phases 1-6 done. Started: 2026-11-24. Timebox: none. Landing branch: deliver/ios-app.
Worktree: /Users/riley/Projects/statglass/.claude/worktrees/deliver-ios-app
Gate: `make agent-config-check agent-config-test agent-hooks-test verification-test architecture-check architecture-test rust-check appstore-check rust-test bindings-check mobile-check mobile-rust-check && bun run check` (about 10 min; `make check` minus `updater-patch-test`, which fails in any worktree nested under the main checkout and runs once from main after the merge; `bun run check` alone is 68 s).
Commits: conventional commit subjects are enforced by the commit hook (`type(scope): subject`). Filtered tests: `bun run test -- <path>` (desktop and packages/core), `bun run --cwd apps/mobile test -- <path>` (mobile, jest-expo), `cargo test -p <crate> <filter>` (Rust). Typecheck: `bun run typecheck`.
Runner: plain commands.
Worktree setup: `bun install --frozen-lockfile`.
Executors: phase 1 lanes run as opus `ce:builder` agents. Phases 2 to 12 run as foreman Codex runs (model gpt-6.2-sol), one run per lane, each with a contract built from the lane brief below; lane review, check-lane and landing are unchanged.

Source RFC: `plan/rfc-ios-app.md` (revision 2). Section numbers below refer to it.

## Spec

StatGlass for iPhone is a read-only viewer for the Macs and Linux servers a person already monitors with StatGlass. It reaches each host over SSH (russh inside the app, Secure Enclave key, forced-command restricted session), speaks the existing CBOR session protocol through Rust code shared with the desktop, keeps a small per-host mirror, and draws the desktop popover's card stack natively in an Expo app.

In scope (this run: RFC phases 0 to 4, verified in the iOS Simulator):

- Reopened 2026-11-25: a foundation phase from the architecture, error and test audits (phase 7, including the host-served network addresses query); RFC phase 4's remaining work, pairing in the app (phase 8, one OS-neutral "Add a host" flow, the user's decision, with screen-scoped data demand in lane d) and the Mac handing its other hosts to the phone (phase 9); and design and UX parity with the macOS app (phase 10 onward, lanes from `plan/rfc-ios-polish.md` after its review).

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

Out of scope: RFC phases 5 and 6 (hardening checklist on devices, NAT64 test, TestFlight, App Store submission), pairing from a physical iPhone, Home Screen widgets, iPad layout, manual host entry, ProxyJump, SSH certificates, moving the desktop into `apps/desktop`, adding `docs-site` to the workspace. By the user's choice (2026-11-25), the phone is a basic monitor, not an investigation tool: no brush or range selection and its attribution, selection veils or chips, per-app usage tables over a range (the user chose the live process table over reopening the restricted allowlist), row expansion or drill-down. No background modes or BGTask work.

Assumptions (user can override):

- The Secure Enclave is not available in the iOS Simulator, so the signer has two implementations behind one Swift protocol: Secure Enclave on device, a Keychain `ThisDeviceOnly` P-256 software key in the simulator. Simulator verification uses the software key.
- The simulator end-to-end checks (phases 7 and 8) use a Linux `statglass-agent` in the repo's ssh-docker OpenSSH container as the host: `statglass-agent pair` prints the payload and code, and approval happens in the terminal. The run does not turn on macOS Remote Login or edit `~/.ssh/authorized_keys`, so the Mac's "Pair iPhone" side is verified by its existing tests and the browser dev server with the mock transport.
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
- Mobile: the first-launch screen renders the title, "Pair with your Mac", "Add a Linux server" and "Try demo hosts" (accessible roles: buttons); the providers are the real ones; tests run under jest-expo on Node. (Superseded 2026-11-25 by the user's one "Add a host" flow, phase 7.)
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
- Behavior: first-launch screen per RFC 1.4: app name, one sentence on what it does, primary "Pair with your Mac", secondary "Add a Linux server", and "Try demo hosts"; the three actions are buttons with accessible labels and do nothing yet beyond navigating to placeholder routes `pair`, `pair-linux`, `demo` that say "Not built yet" (replaced in phases 6 and 7). Colors come from the shared token source: check whether NativeWind can read `src/app/styles/theme.css` (or tokens.css) directly; if it can, import it; if it cannot, write a small generator `apps/mobile/scripts/gen-theme.mjs` that emits `apps/mobile/src/theme.generated.css` and a plain color map from `theme.css`, with a check that fails on drift. Record which in your report. Light and dark appearance follow the system. `single-react.mjs` counts React module definitions in the Hermes/JS bundle by package path and exits 1 with the paths when more than one copy exists; its fixture test runs under `node --test`. Add `apps/mobile/test/core-import.test.ts` that imports `@core/format` and `@core/live-state` and calls one function from each, proving the alias works under jest. CI: add a Linux job `mobile` to `.github/workflows/ci.yml` that runs on changes under `apps/mobile/**`, `packages/**`, `bun.lock`, `scripts/mobile/**`, and runs `make mobile-check`'s Linux-capable steps (all of check.sh runs on Linux). No macOS runner. (Superseded 2026-11-25 by the user's one "Add a host" flow, phase 7.)
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
Scaffold: 9b312222
Tag: ios-app-phase-3

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
| a | L | crates/statglass-ipc/src/live.rs, crates/statglass-ipc/src/live/, crates/statglass-ipc/src/history.rs, crates/statglass-ipc/src/history/, crates/statglass-ipc/src/vitals.rs, crates/statglass-ipc/src/status.rs, crates/statglass-ipc/src/process.rs, src-tauri/src/live.rs, src-tauri/src/live/, src-tauri/src/live_host_tests.rs, src-tauri/src/ipc.rs, src-tauri/src/state.rs, src-tauri/src/commands.rs, src-tauri/src/windows.rs, src-tauri/src/live_process.rs, src-tauri/src/app_quit.rs, src-tauri/src/process_signal/, src-tauri/src/history/ipc.rs, src-tauri/src/history/queries.rs, src-tauri/src/remote/contracts.rs, src-tauri/src/remote/vitals.rs, src-tauri/src/remote/registration.rs, src-tauri/src/remote/commands.rs, src-tauri/src/hosts.rs, scripts/architecture/rust-size-ceilings.txt, src-tauri/src/history.rs, src-tauri/src/lib.rs, src-tauri/src/history/tests.rs, packages/core/src/generated/types.ts | contracts, RFC 4.4 | moved live/history tests, `RemoteHostStatus` snapshot | gpt-6.2-sol | merged | foreman/ios-p3a | `cargo test -p statglass-ipc -p statglass`, `make bindings-check` (scaffold drift only), `bun run typecheck`, `make e2e-perf` and `make architecture-check` pass; `cargo check --target aarch64-apple-ios-sim -p statglass-ipc` passes; `git diff -M --stat` shows the moves as renames |
| b | M | crates/statglass-session/src/mirror.rs, crates/statglass-session/src/mirror/, crates/statglass-session/src/mirror_policy.rs, crates/statglass-store/src/reader.rs, crates/statglass-store/src/reader/, crates/statglass-store/tests/covered_tier.rs, crates/statglass-ipc/tests/phase3_gate.rs, crates/statglass-session/src/mirror_sink.rs | contracts, RFC 4.3, RFC 5 | mirror policy, `Covered` resolution, phase gate | gpt-6.2-sol | merged | foreman/ios-p3b | `cargo test -p statglass-session mirror`, `cargo test -p statglass-store` and `cargo test -p statglass-ipc --test phase3_gate` pass; clippy clean |
| c | L | crates/statglass-session/src/source.rs, crates/statglass-session/src/source/, crates/statglass-session/src/network.rs, crates/statglass-session/src/network/, crates/statglass-session/src/connect.rs, crates/statglass-session/src/connect/, crates/statglass-session/src/dialer.rs | contracts, RFC 2.2, 4.5 | source tests under paused time | gpt-6.2-sol | merged | foreman/ios-p3c | `cargo test -p statglass-session` and `cargo test -p statglass remote` pass; `make architecture-check` passes with `source.rs` at or under its ceiling |

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
Scaffold: 36dcbc94
Tag: ios-app-phase-4

How the demo runs:
- `scripts/mobile/build-rust-ios.sh` builds the XCFramework.
- The app opens `statglass://debug`. The debug screen shows the phone's `authorized_keys` line, which goes into `~/.ssh/authorized_keys` on this Mac by hand.
- With this Mac's address, user and `MacHelper` path filled in (prefilled from `EXPO_PUBLIC_STATGLASS_DEBUG_*`), Connect starts a full session over russh. The screen then shows the connection state and CPU updating at 1 Hz.
- Pairing, restricted keys and the hosts list on real data are phase 7.

Code facts this phase relies on (checked 2026-11-24 against 36dcbc94):

**Facade**
- `RemoteSource::with_options(record, local, dialer, endpoint, on_status, mirror, SourceOptions { runtime, sync, probe })` is the phone's way in.
- Session controls:
  - `set_sync_policy(SyncPolicy::{Full, SummaryOnly, Off})`
  - `quiesce() -> BoxFuture<'static, ()>`
  - `resume()`, which is idempotent
  - `network_changed_with(LocalNetwork { online, tailscale_up, lan_up })`
  - `set_recent_interest`
- `Mirror::with_policy(history, host, MirrorPolicy::phone(budget_mb))` fixes the budget at construction; there is no setter. `PHONE_MIRROR_HOST_MB` is 25 and `PHONE_MIRROR_TOTAL_MB` is 250.
- The desktop builds a source in `src-tauri/src/remote/registration.rs:14-80`. It opens one `History` per host under `mirrors/<id>/` with mode 0700, then `register_host`, then the `Mirror`, then the source.

**ipc**
- `LiveRegistry::subscribe(label, Arc<dyn LiveFeed>, Arc<dyn LiveSink>, LiveRequest)`. `LiveSink` is `{ send(LiveMsg) -> bool; id() -> u32 }`.
- The `LiveFeed` pattern is `impl LiveFeed for HostEntry` in `src-tauri/src/hosts.rs`.
- Other ipc functions used: `query_history(history, request, auto, recent, hold)`, `query_events`, `status::connection_status(&ConnectionStatus) -> RemoteConnection` and `vitals::host_vitals`.

**ssh**
- `RusshDialer::new(Arc<dyn Signer>)`.
- `Signer::sign` returns ASN.1 DER, and `RusshSigner` converts it to the SSH blob. A `public_key()` that is not a 65-byte SEC1 point makes the dialer refuse the key.
- `SoftwareSigner` is behind the `software-signer` feature, which is a dev-dependency of statglass-mobile.

**Native module**
- `requireOptionalNativeModule` and `NativeModule` are imported from `"expo"`; expo-modules-core is installed only in the root `node_modules`.
- The XCFramework and the Swift bindings come from `scripts/mobile/build-rust-ios.sh` and are git-ignored (`apps/mobile/.gitignore:13-16`).
- The app lock is `apps/mobile/src/lock/app-lock-gate.tsx`, which uses a JS `AppState` and `BlurView` cover. Lane 6a q3 moved the native snapshot cover here.
- The About screen (`apps/mobile/src/app/settings/about.tsx`) shows only `Constants.expoConfig?.version`.

#### Scaffold contracts (phase 4)

**New crate edges**

statglass-mobile → statglass-session, statglass-ipc and statglass-ssh, plus statglass-ssh again as a dev edge for `software-signer`. They are in `crate-edges.json`, and `make architecture-check` passes.
- RFC 4.2 step 5 has the facade depend on ipc, for the command layer and the types the app already reads, and on session, for `RemoteSource` and `Mirror`.
- The russh dialer and the `Signer` trait live in statglass-ssh.
- statglass-mobile still never depends on statglass-remote.
- tokio (`rt`, `rt-multi-thread`, `sync`, `time`, `macros`) and thiserror/tracing are existing workspace dependencies.
- UniFFI's `tokio` feature is not used, because it would pull in async-compat. The core owns its runtime instead, and async exports await a `JoinHandle`, which works on any executor.

**Scaffold-owned files.** No lane edits these. A change to them goes back through the orchestrator.
- `crates/statglass-mobile/src/{lib,mobile_core,ffi,envelope}.rs` and `Cargo.toml`. `control.rs` is lane d's, with its methods fixed (see the table notes).
- `crates/statglass-ipc/src/mobile.rs` and `src-tauri/src/facts.rs`, together with the regenerated `types.ts`
- `crates/statglass-ssh/src/signer.rs`, for `authorized_key_line`
- `apps/mobile/src/app/_layout.tsx` and `apps/mobile/src/app/debug.tsx`
- `apps/mobile/src/transport/index.ts`, `apps/mobile/modules/statglass-native/index.ts` and `src/StatglassNative.types.ts`
- the `@native/*` alias in `apps/mobile/{tsconfig.json,metro-resolve.cjs,jest.config.cjs}`
- the `mobile-native-check` target in `Makefile`

**Facade types in `statglass_ipc::mobile`.** These are serde and specta types registered with `.typ::<T>()` in `facts.rs`, so TypeScript gets them from `types.ts`:

```rust
pub struct MobileConfig { pub hosts: Vec<MobileHost>, pub data: DataPolicy }
pub struct DataPolicy { pub sync_on_cellular: bool }            // Default: false
pub struct MobileHost {
    pub id: HostId, pub name: String, pub user: String, pub port: Option<u16>,
    pub targets: Vec<MobileTarget>, pub host_keys: Vec<MobileHostKey>, pub command: MobileCommand,
}
pub struct MobileTarget { pub route: RemoteRoute, pub host: String }
pub struct MobileHostKey { pub algorithm: String, pub sha256: String }
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MobileCommand { Restricted, MacHelper { path: String }, Agent { bin: String, system: bool, socket: Option<String> } }

#[serde(tag = "method", content = "args", rename_all = "snake_case")]
pub enum MobileCall {
    BuildInfo, SetHosts { hosts: Vec<MobileHost> }, SetDataPolicy(DataPolicy),
    AuthorizedKeyLine { comment: String },
    ListHosts, ListRemoteHosts, GetHost { host: HostId }, GetCapabilities { host: HostId },
    HostVitals { host: HostId }, SetHostsRecentInterest { on: bool }, RetryRemoteHost { host: HostId },
    SubscribeLive(MobileLiveRequest), UnsubscribeLive { stream: u32 },
    QueryHistory(HistoryRequest), QueryEvents { host: HostId, from_ms: i64, to_ms: i64 },
}
pub struct MobileLiveRequest {
    pub host: HostId, pub stream: u32, pub backfill_ms: Option<i64>,
    pub series: Option<Vec<SeriesSelector>>, pub min_period_ms: Option<u32>,
}
pub struct MobileRemoteHost {
    pub id: HostId, pub name: String, pub os: OsKind, pub targets: Vec<MobileTarget>,
    pub mirror_budget_mb: u32, pub connection: RemoteConnection,
    pub last_seen_ms: Option<i64>, pub synced_through_ms: Option<i64>, pub next_attempt_ms: Option<i64>,
    pub attempt: u32, pub dialing: bool, pub waiting_for_network: bool, pub clock_offset_ms: Option<i64>,
    pub vitals: HostVitals, pub agent_version: Option<String>, pub identity_changed: Option<HostId>,
}
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MobileEvent { HostsChanged { hosts: Vec<HostRecord> }, RemoteHostsChanged }
```

**UniFFI surface in `statglass-mobile`.** Every string a method returns is the desktop envelope, `{status:"ok",data}` or `{status:"error",error:CommandError}`. A panic becomes `internal`, through `catch_unwind` in `envelope.rs` for synchronous methods and through `JoinError` for spawned ones.

```rust
#[derive(uniffi::Object)] pub struct MobileCore { .. }
#[uniffi::export] impl MobileCore {
    #[uniffi::constructor] pub fn new(signer: Arc<dyn NativeSigner>, events: Arc<dyn CoreEvents>) -> Arc<Self>;
    pub fn start(&self, data_dir: String, config_json: String) -> String;   // data: null
    pub async fn call(&self, method: String, args_json: String) -> String;  // MobileCall; "" or "null" = no args
    pub async fn quiesce(&self) -> String;                                  // data: null; resolves after mirror writes commit
    pub fn resume(&self) -> String;                                         // data: null; returns at once
    pub fn path_changed(&self, path: NetworkPath) -> String;                // data: null
}
#[uniffi::export] pub fn version() -> String;                               // envelope of BuildInfo { version, protocol_min, protocol_max }

#[uniffi::export(with_foreign)] pub trait NativeSigner: Send + Sync {
    fn public_key(&self) -> Vec<u8>;                                         // SEC1 uncompressed P-256, 65 bytes
    fn sign(&self, data: Vec<u8>) -> Result<Vec<u8>, NativeSignerError>;     // ECDSA P-256 SHA-256, ASN.1 DER
}
#[derive(uniffi::Error)] pub enum NativeSignerError { Unavailable { message }, Refused { message }, Unexpected { message } }
#[uniffi::export(with_foreign)] pub trait CoreEvents: Send + Sync {
    fn live(&self, stream: u32, message_json: String) -> bool;               // LiveMsg JSON; false = listener gone
    fn event(&self, event_json: String);                                     // MobileEvent JSON
}
#[derive(uniffi::Record)] pub struct NetworkPath { pub satisfied: bool, pub expensive: bool, pub constrained: bool }
```

`MobileCore::call` answers `BuildInfo`, `SetHosts`, `SetDataPolicy` and `AuthorizedKeyLine` itself and routes every other call to `Sessions::call`. `start` builds a multi-thread runtime named `statglass-core` on first use.

**The seam between lanes a and d** (`control.rs`, scaffold-owned):

```rust
pub(crate) trait SessionControl: Send + Sync {
    fn sources(&self) -> Vec<Arc<RemoteSource>>;   // the open host (one with a live stream) first
    fn set_sync_policy(&self, policy: SyncPolicy);  // running sources and later ones
    fn network_changed(&self, net: LocalNetwork);
}
```

Lane a implements it on `Sessions`. Lane d calls it from `Lifecycle`, and its tests use a fake that holds real sources. Lane d removes the `#[expect(dead_code)]` on the trait.

**Stub files**

Lane a, `sessions.rs`. Every stub returns `CommandError::Internal`.

```rust
pub(crate) struct Sessions { .. }
impl Sessions {
    pub(crate) fn new(events: Arc<dyn CoreEvents>) -> Self;
    pub(crate) fn start(&self, runtime: Handle, data_dir: PathBuf, config: MobileConfig,
                        signer: Arc<dyn statglass_ssh::Signer>, sync: SyncPolicy) -> Result<(), CommandError>;
    pub(crate) fn set_hosts(&self, hosts: Vec<MobileHost>, sync: SyncPolicy) -> Result<(), CommandError>;
    pub(crate) async fn call(&self, call: MobileCall) -> Result<serde_json::Value, CommandError>;
}
impl SessionControl for Sessions { .. }
```

Lane d, `lifecycle.rs`, `policy.rs` and `signer.rs`:

```rust
pub(crate) struct Lifecycle { .. }
impl Lifecycle {
    pub(crate) fn new() -> Self;
    pub(crate) fn sync_policy(&self) -> SyncPolicy;
    pub(crate) fn quiesce(&self, sessions: &dyn SessionControl) -> BoxFuture<'static, ()>;
    pub(crate) fn resume(&self, sessions: &dyn SessionControl);
    pub(crate) fn path_changed(&self, sessions: &dyn SessionControl, path: NetworkPath);
    pub(crate) fn set_data_policy(&self, sessions: &dyn SessionControl, data: DataPolicy);
}
pub(crate) fn sync_policy(path: Option<NetworkPath>, data: DataPolicy) -> SyncPolicy;   // stub: Full
pub(crate) fn host_budget_mb(hosts: usize) -> u32;                                      // stub: 25
pub(crate) struct NativeSignerAdapter { .. }   // impl statglass_ssh::Signer
impl NativeSignerAdapter { pub(crate) fn new(native: Arc<dyn NativeSigner>) -> Self; }
pub(crate) fn authorized_key_line(native: &dyn NativeSigner, comment: &str) -> Result<String, CommandError>;
```

**statglass-ssh.** The scaffold implements this one fully and tests it:

```rust
pub fn authorized_key_line(public_sec1: &[u8], comment: &str) -> Result<String, SignerError>;
```

It produces `ecdsa-sha2-nistp256 <base64> <comment>`, and a point that is not 65-byte uncompressed P-256 gives `Invalid`.

**Native module** (`apps/mobile/modules/statglass-native/`)

- `expo-module.config.json` declares `StatglassNativeModule` for Apple.
- `ios/StatglassNative.podspec` depends on ExpoModulesCore, vendors `StatglassCore.xcframework`, compiles `**/*.swift` and targets iOS 16.
- `src/StatglassNative.types.ts`, scaffold-owned:

```ts
interface LivePayload { stream: number; message: string }        // message: LiveMsg JSON
interface CoreEventPayload { event: string }                      // event: MobileEvent JSON
type StatglassNativeEvents = { onLive(p: LivePayload): void; onCoreEvent(p: CoreEventPayload): void };
interface StatglassNativeModule extends NativeModule<StatglassNativeEvents> {
  version(): string;                                               // the Rust version() envelope
  start(configJson: string): Promise<string>;                      // Swift supplies data_dir
  call(method: string, argsJson: string): Promise<string>;
  setSnapshotCover(enabled: boolean): void;
}
type NativeModuleErrorKind = "keychain" | "secureEnclave" | "camera" | "localNetwork";
interface NativeModuleError { kind: NativeModuleErrorKind; osStatus: number | null; message: string }
```

- Stubs lane b fills in:
  - `src/StatglassNativeModule.ts`: `getStatglassNative(): StatglassNativeModule | null`. This one is already real: a cached `requireOptionalNativeModule`, which returns null in Jest and Expo Go.
  - `src/native-error.ts`: `toNativeModuleError(error: unknown): NativeModuleError | null`
  - `ios/StatglassNativeModule.swift`: `Name("StatglassNative")`, `Events("onLive","onCoreEvent")`, `Function version`, `AsyncFunction start` and `call`, and `Function setSnapshotCover`
  - `ios/PhoneKey.swift`:
    - `enum NativeFailure { keychain(osStatus:message:), secureEnclave(osStatus:message:), localNetwork(message:) }`
    - `protocol PhoneKey { publicKey() throws -> Data; sign(_:) throws -> Data }`
    - `SecureEnclaveKey`, `SimulatorKey`, and `currentPhoneKey()`, which chooses between them with `#if targetEnvironment(simulator)`
  - `ios/AppLifecycle.swift`: `AppLifecycle { start(); stop() }` and `SnapshotCover { enabled; start(); stop() }`
- `scripts/mobile/native-check.sh` is a stub that exits 1. `make mobile-native-check` runs it.

**Transport skeleton** (`apps/mobile/src/transport/`). Every stub throws "not implemented (phase 4 lane c)".

```ts
interface NativeTransport extends PhoneTransport {
  setHosts(hosts: MobileHost[]): Promise<CommandResult<null>>;
  setDataPolicy(policy: DataPolicy): Promise<CommandResult<null>>;
  authorizedKeyLine(comment: string): Promise<CommandResult<string>>;
  buildInfo(): Promise<CommandResult<BuildInfo>>;
  dispose(): void;
}
startNativeTransport(native: StatglassNativeModule, config: MobileConfig): Promise<CommandResult<NativeTransport>>;
createNativeTransport(native: StatglassNativeModule): NativeTransport;
isNativeTransport(t: PhoneTransport | null): t is NativeTransport;            // real
parseEnvelope<T>(json: string): CommandResult<T>;
createLiveStreams(native): LiveStreams;   // { open(host, onMsg, options?): Promise<LiveSubscription>; dispose(): void }
toRemoteHostRecord(host: MobileRemoteHost): RemoteHostRecord;
nativeBuildInfo(native: StatglassNativeModule | null): BuildInfo | null;
protocolRangeText(info: BuildInfo): string;
NativeCoreBridge(): null;                 // mounted in _layout.tsx; returns null until lane c
```

- `apps/mobile/src/app/debug.tsx` re-exports `DebugScreen` from `@/debug/debug-screen`, which is a stub that says "Not built yet". The route is registered in `_layout.tsx` as `debug`, so the deep link is `statglass://debug`.
- `@native/*` maps to `apps/mobile/modules/*` in tsconfig, Metro and Jest, with a resolver test. It exists because Biome bans `../` imports in the app.

Test cases:

**Facade core (scaffold, passing)**
- An unknown method gives `invalid_argument`.
- A unit call parses with `""` or `"null"` args, and a call with args parses.
- A panic inside `envelope::run` is an `internal` error envelope.
- A `CommandError` keeps its kind in the envelope.
- `version()` returns the envelope with the protocol range.
- `authorized_key_line` on a bare point equals `SoftwareSigner`'s line and rejects malformed points.

**Phase gate**
- The demo above, recorded as simulator screenshots of the debug screen before and after Connect, plus the About screen.
- `make mobile-native-check`, `make mobile-check`, `make mobile-rust-check`, `cargo test -p statglass-mobile` and `make architecture-check` pass.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-mobile/src/sessions.rs, crates/statglass-mobile/src/sessions/, crates/statglass-mobile/tests/, scripts/ssh-docker/run.sh | contracts, RFC 4.2, src-tauri/src/remote/registration.rs, src-tauri/src/hosts.rs | sessions unit tests over a fake dialer; ignored Docker full-session test | gpt-6.2-sol | merged | foreman/ios-p4a | `cargo test -p statglass-mobile` passes with the lane a cases; `make ssh-docker-test` passes `mobile_session`; `make mobile-rust-check` and `make rust-check` clean |
| b | M | apps/mobile/modules/statglass-native/ios/StatglassNativeModule.swift, apps/mobile/modules/statglass-native/ios/PhoneKey.swift, apps/mobile/modules/statglass-native/ios/AppLifecycle.swift, apps/mobile/modules/statglass-native/ios/StatglassNative.podspec, apps/mobile/modules/statglass-native/src/native-error.ts, apps/mobile/modules/statglass-native/src/StatglassNativeModule.ts, scripts/mobile/native-check.sh, apps/mobile/src/lock/snapshot-cover.ts, apps/mobile/src/lock/app-lock-gate.tsx, apps/mobile/test/native/, apps/mobile/src/lock/app-lock-setting.tsx | contracts, RFC 3.8, 4.5, .claude/rules/mobile/native-module.md | native error parsing and snapshot-cover jest tests; simulator build | gpt-6.2-sol | merged | foreman/ios-p4b | `make mobile-native-check` passes and leaves no `apps/mobile/ios`; `make mobile-check` passes; simulator screenshot of the app switcher with the lock on |
| c | M | apps/mobile/src/transport/envelope.ts, apps/mobile/src/transport/live-streams.ts, apps/mobile/src/transport/remote-hosts.ts, apps/mobile/src/transport/native-transport.ts, apps/mobile/src/transport/build-info.ts, apps/mobile/src/transport/native-core-bridge.tsx, apps/mobile/src/debug/, apps/mobile/src/app/settings/about.tsx, apps/mobile/test/transport/, apps/mobile/test/debug/, apps/mobile/test/settings/about.test.tsx, apps/mobile/modules/statglass-native/src/StatglassNative.types.ts, apps/mobile/tsconfig.node.json | contracts, apps/mobile/src/data/seam.ts, packages/core/src/mock-transport.ts | transport jest tests over a fake native module; About and debug screen tests | gpt-6.2-sol | merged | foreman/ios-p4c | `make mobile-check` passes with the lane c cases; About and debug screens checked against `plan/design-system.md` and the settings screens, differences named |
| d | M | crates/statglass-mobile/src/lifecycle.rs, crates/statglass-mobile/src/lifecycle/, crates/statglass-mobile/src/policy.rs, crates/statglass-mobile/src/signer.rs, crates/statglass-mobile/src/control.rs, crates/statglass-mobile/Cargo.toml, Cargo.lock | contracts, RFC 4.4, 4.5, crates/statglass-session/src/source/quiesce.rs | lifecycle tests under paused time over a fake `SessionControl`; policy and signer unit tests | gpt-6.2-sol | merged | foreman/ios-p4d | `cargo test -p statglass-mobile` passes with the lane d cases; `make mobile-rust-check` and `make rust-check` clean |

Notes on the table:
- `control.rs` is listed under lane d only so that it can delete the trait's `#[expect(dead_code)]`. Lane d does not change the trait's methods.
- Lane a's `Sessions` implements the trait exactly as it is in the scaffold.
- Lane a is the largest lane because the session registry is one capability that cannot be split further: hosts, sources, mirrors, live sinks and the call mapping share one map. It stays within about twice lane d's size.
- Lane b owns `app-lock-gate.tsx`; phase 6 lane a, which owned it before, has merged.
- Lane c owns `about.tsx`, which comes out of phase 6 lane a's `settings/` the same way.
- No phase 4 path overlaps phase 5's running lanes. Phase 5 lane c owns `packages/core/src/remote-connection*.ts`; lane c here reads them and does not edit them.

#### Lane a brief

- **Goal:** Make the core run real sessions. Each host gets a `RemoteSource` over the russh dialer, a phone-policy mirror, and live streams pushed through `CoreEvents`, and the phone's host, live and history calls are answered from them. This is everything the debug screen needs to show live CPU from this Mac.
- **Interface:** the scaffold's `Sessions` (`new`, `start`, `set_hosts`, `call`) and `impl SessionControl for Sessions`. Extract into `sessions/` as it grows. A likely split is `sessions/{registry,endpoint,live,commands,phone_id}.rs`, each with its tests in `sessions/tests/`.
- **Behavior:**
  - **`start`**
    - Creates `data_dir` with mode 0700.
    - Loads or creates the phone's own `HostId` in `data_dir/phone-id`. A file that does not parse is an error and is never replaced silently.
    - Then calls `set_hosts(config.hosts, sync)`.
    - A second `start` gives `invalid_argument`.
  - **`set_hosts`**
    - Hosts no longer listed: stop the source, drop its live streams, and keep the mirror files on disk. Deleting them belongs to forgetting a host in phase 7.
    - New hosts:
      - Open `History` at `data_dir/mirrors/<id>/` (mode 0700) and `register_host`.
      - Build `Mirror::with_policy(history.store(), id, MirrorPolicy::phone(crate::policy::host_budget_mb(hosts.len())))`.
      - Build the source with `RemoteSource::with_options(record, phone_id, Arc::new(RusshDialer::new(signer)), endpoint, on_status, Some(mirror), SourceOptions { runtime: Some(handle), sync, ..Default::default() })`.
    - A running host whose budget share changed is rebuilt with the new budget, because `Mirror`'s budget is fixed at construction.
      - `set_hosts` is synchronous and does not wait for the rebuild. It spawns a task on the core runtime that awaits the old source's `quiesce()`, stops it, then opens the new mirror and source on the same directory.
      - That way only one mirror writes a host's SQLite file at a time, and no write is cut off.
      - A call for that host during the rebuild gets the old source's answer, or `unknown_host` in the instant between the two sources.
    - Afterwards, emit `MobileEvent::HostsChanged` and `RemoteHostsChanged`.
    - An invalid host gives `invalid_argument` and changes nothing. Invalid means no targets, an empty user, or a duplicate id.
  - **Endpoint mapping**
    - `MobileHost` maps to the session `Endpoint`: targets in order, user, port, and the remote command from `MobileCommand`.
    - `MacHelper` runs the helper path, `Agent` runs the agent's `serve` command with `system` and `socket`, and `Restricted` sends no command.
    - `host_keys` are passed to the dialer's host-key check.
  - **Status**
    - `on_status` keeps the latest `ConnectionStatus` per host.
    - It emits `RemoteHostsChanged` only when the `MobileRemoteHost` it maps to changes. Live frames call it at 1 Hz, so a frame that changes nothing emits nothing.
  - **`call`**
    - `ListHosts` returns `HostRecord`s.
    - `ListRemoteHosts` returns `MobileRemoteHost`s, built with `connection_status`, `host_vitals` and the mirror's `sync_watermark`.
    - `GetHost` and `GetCapabilities` read the source's record and capabilities. An unknown host gives `unknown_host`.
    - `HostVitals` and `RetryRemoteHost` call the source.
    - `SetHostsRecentInterest { on }` calls `set_recent_interest` on every source.
    - `QueryHistory` and `QueryEvents` go through `statglass_ipc` on the host's mirror history with `MirrorPolicy::phone`'s `auto_choice`. The blocking SQLite read runs in `spawn_blocking`.
  - **Live**
    - `SubscribeLive(req)` registers a `LiveSink` whose `send` calls `events.live(req.stream, json)` and whose `id()` is `req.stream`. It goes through a `LiveRegistry` with an `impl LiveFeed` for the phone's host entry, following `src-tauri/src/hosts.rs`.
    - When `live` returns false, the stream ends and its registry entry goes.
    - `UnsubscribeLive { stream }` ends that stream. An unknown stream is a no-op, not an error.
    - The source with a live stream is the open host, which `SessionControl::sources()` lists first.
  - **`SessionControl`** forwards `set_sync_policy` and `network_changed` (`network_changed_with`) to every source. `set_sync_policy` also records the policy for sources started later.
  - **Docker test**
    - Add `crates/statglass-mobile/tests/mobile_session.rs`, `#[ignore]`d, plus its `run.sh` entry.
    - With `SoftwareSigner` and the key `run.sh` installs, `Sessions::start` against the Docker agent receives a live frame with `cpu.usage` through a recording `CoreEvents`.
    - `QueryHistory` on the mirror then returns M1 rows after sync.
- **Test cases:**
  1. `start` creates `phone-id` once. A second core on the same directory reads the same id, and a corrupt `phone-id` gives an error and leaves the file as it was.
  2. `set_hosts` with two hosts gives each a mirror with a 25 MB budget. Going to 11 hosts rebuilds every mirror at `250 / 11 = 22` MB, and each old source was quiesced before it stopped.
  3. Removing a host stops its source, and a later `GetHost` for it gives `unknown_host`. Its mirror directory still exists.
  4. An invalid host list (an empty user, or a duplicate id) gives `invalid_argument`, and the running hosts are unchanged.
  5. `MobileCommand::{Restricted, MacHelper, Agent}` map to the endpoint commands the desktop uses for the same host kinds. This is a fixture comparison.
  6. `SubscribeLive` on a host whose fake dialer streams frames calls `CoreEvents::live(stream, json)` in order, and the JSON decodes as `LiveMsg`.
  7. `CoreEvents::live` returning false ends the stream: no further calls, and the registry entry is removed.
  8. `UnsubscribeLive` on an unknown stream returns `null`.
  9. `ListRemoteHosts` JSON matches `MobileRemoteHost` for a fixture status. Two `on_status` calls with the same status emit one `RemoteHostsChanged`.
  10. `QueryHistory` on a seeded phone mirror resolves `auto` 24 h to M1 and 7 d to M15.
  11. `SessionControl::sources()` lists the host with a live stream first, and `set_sync_policy(Off)` reaches a source started after the call.
  12. The Docker test (`mobile_session`) streams `cpu.usage` and syncs M1.
- **Decisions already made:**
  - One `History` per host under `mirrors/<id>/`, as on the desktop.
  - The phone id is a file in `data_dir`.
  - Budgets are recomputed on every `set_hosts`, using lane d's `host_budget_mb`.
  - Removing a host never deletes its mirror in this phase.
  - There is no concurrency cap; the cap of 8 sessions and rotation are phase 7.
- **Out of scope:**
  - Lifecycle and path handling, the sync policy rule, and the signer (lane d).
  - Swift (lane b) and TypeScript (lane c).
  - Pairing and restricted-key behavior on hosts (phase 5).
- **Done when:** the conditions in the table are met.

#### Lane b brief

- **Goal:** Make the native module real. Swift holds the phone's key and the Rust core, forwards calls and events unread, drives backgrounding, foregrounding and path changes, and covers the app-switcher snapshot when the app lock is on. A check proves it all builds for the simulator.
- **Interface:** the scaffold's `StatglassNativeModule` TS interface and Swift stubs, `toNativeModuleError`, and `scripts/mobile/native-check.sh`. This lane adds `apps/mobile/src/lock/snapshot-cover.ts`, exporting `useSnapshotCover(enabled: boolean): void`.
- **Behavior:**
  - **Module lifecycle.** On `OnCreate`, build `MobileCore(signer: PhoneKeySigner(currentPhoneKey()), events: EventsBridge(module))`.
    - `PhoneKeySigner` maps a `NativeFailure` to `NativeSignerError`: `keychain` and `secureEnclave` become `Unavailable` with the OSStatus in the message.
    - `EventsBridge.live` sends `onLive { stream, message }` and returns false once the module has no listeners. `event` sends `onCoreEvent { event }`.
  - **Calls**
    - `start(configJson)` resolves `data_dir` to `Application Support/statglass` with file protection `completeUntilFirstUserAuthentication` and excluded from backup, then calls `core.start`.
    - `call` forwards to `core.call`.
    - `version` forwards to the UniFFI `version()`.
    - Swift never parses the JSON it carries.
  - **Keys**
    - `SecureEnclaveKey` creates or loads a P-256 key with the tag `app.statglass.phone-key` (`kSecAttrTokenIDSecureEnclave`, `privateKeyUsage`, `ThisDeviceOnly`).
    - `SimulatorKey` creates or loads a software P-256 key in the Keychain under the same tag with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
    - `publicKey()` is `SecKeyCopyExternalRepresentation` of the public key (65 bytes). `sign` is `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)`.
  - **Errors.** A failure that reaches JS rejects with Expo code `ERR_STATGLASS_<KIND>`, where KIND is one of `KEYCHAIN`, `SECURE_ENCLAVE`, `CAMERA` or `LOCAL_NETWORK`, and the message `"<message> (OSStatus <n>)"`. `toNativeModuleError` turns that into `NativeModuleError`. Anything else gives `null`.
  - **`AppLifecycle`**
    - On `didEnterBackground`: `beginBackgroundTask`, then `await core.quiesce()`, then `endBackgroundTask`. The expiration handler also ends the task.
    - On `willEnterForeground`: `core.resume()`.
    - `NWPathMonitor` on a private queue calls `core.pathChanged(NetworkPath(satisfied:expensive:constrained:))` on every update, including the first.
    - `start` runs from `OnCreate` and `stop` from `OnDestroy`.
  - **`SnapshotCover`**
    - When `enabled`, `willResignActive` puts a `UIVisualEffectView` (system material) over every foreground window scene before UIKit takes the snapshot. `didBecomeActive` removes it.
    - `setSnapshotCover(enabled)` sets the flag.
    - `useSnapshotCover(enabled)` calls `getStatglassNative()?.setSnapshotCover(enabled)` when `enabled` changes, and it is mounted in `app-lock-gate.tsx` with the lock setting.
    - The JS blur in the gate stays for the in-app lock screen.
    - RFC 3.8: the cover applies only while the app lock is on.
  - **`native-check.sh`**
    - Builds with `scripts/mobile/build-rust-ios.sh`, then runs `expo prebuild --platform ios --no-install` into `apps/mobile/ios`, then `pod install`, then `xcodebuild -workspace … -scheme StatGlass -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build`.
    - A `trap` removes `apps/mobile/ios` on every exit, and the script fails if `apps/mobile/ios` already exists when it starts.
    - It prints which step failed.
- **Test cases:**
  1. `toNativeModuleError` on a rejection coded `ERR_STATGLASS_KEYCHAIN` with `"item not found (OSStatus -25300)"` gives `{ kind: "keychain", osStatus: -25300, message: "item not found" }`.
  2. Each of the four kinds parses, and `osStatus` is `null` when the message carries none.
  3. A plain `Error`, a string, `null`, or an unknown code gives `null`.
  4. `useSnapshotCover(true)` calls `setSnapshotCover(true)` once. Toggling it calls it with `false`, and re-rendering with the same value does not call it again. Tested with a fake module through Jest's module mock of `@native/statglass-native`.
  5. With no native module (`getStatglassNative()` null), `useSnapshotCover` does nothing and does not throw.
  6. `AppLockGate` with the lock on calls `setSnapshotCover(true)`, and with it off calls `setSnapshotCover(false)`. The existing app-lock tests still pass.
  7. `make mobile-native-check` builds, and a pre-existing `apps/mobile/ios` makes it fail without deleting that directory.
  8. Simulator check by hand: with the lock on, the app switcher shows the cover. With the lock off, it shows the app.
- **Decisions already made:**
  - A Secure Enclave key on a device and a Keychain `ThisDeviceOnly` software key in the simulator (RFC 4.5).
  - Swift is plumbing only.
  - The snapshot cover is native and lock-gated.
  - Quiesce runs inside a background task.
  - Native module tests are JS tests over the module boundary plus the simulator build. There is no XCTest target in this phase.
- **Out of scope:**
  - What the core does on quiesce, resume or a path change (lane d).
  - The transport and screens (lane c).
  - Camera and local-network permissions (phase 7; only the error kinds exist now).
- **Done when:** the conditions in the table are met.

#### Lane c brief

- **Goal:** Make the phone's real transport. It implements the `PhoneTransport` seam over the native module so the existing screens could read a live host. On top of that, the debug screen runs the demo, the About screen shows the core's protocol range, and phone settings reach the core.
- **Interface:** the scaffold's transport skeleton (`native-transport.ts`, `envelope.ts`, `live-streams.ts`, `remote-hosts.ts`, `build-info.ts`, `native-core-bridge.tsx`) and `DebugScreen`.
- **Behavior:**
  - **`parseEnvelope`** returns the `CommandResult` as is. Invalid JSON, or JSON without `status`, gives `{ status: "error", error: { kind: "internal", message } }` naming what arrived (its first 200 characters).
  - **`startNativeTransport`** calls `native.start(JSON.stringify(config))`. A rejection the native module recognizes comes back as the thrown `NativeModuleError`, through `toNativeModuleError`; anything else is rethrown.
  - **`createNativeTransport`**
    - Each seam method calls `native.call(method, JSON.stringify(args))` with the snake_case `MobileCall` method name, then `parseEnvelope`.
    - `listRemoteHosts` maps each `MobileRemoteHost` through `toRemoteHostRecord`.
    - `onHostsChanged` and `onRemoteHostsChanged` subscribe to `onCoreEvent`. `HostsChanged` passes its hosts. `RemoteHostsChanged` refetches `listRemoteHosts` and passes the result, and a failed refetch is passed as the error result, not dropped.
    - `dispose` removes every listener and ends every stream.
  - **`createLiveStreams`**
    - Stream ids start at 1 and are never reused within one transport.
    - `open` registers the callback before calling `subscribe_live`, so the first message is never lost.
    - An `onLive` for an unknown stream is ignored.
    - `unsubscribe` sends `unsubscribe_live` and removes the callback even when the call fails.
    - A failed `subscribe_live` rejects with the error envelope's `CommandError` and leaves no callback behind.
  - **`toRemoteHostRecord`** fills the fields only a Mac controller has with their "none" values:
    - `rr: null`, `update: null`, `last_update_failure: null` and `agent_update: { kind: "unknown" }`
    - `config` built from `name`, `targets` and `mirror_budget_mb`
    - Every other field is copied.
  - **About**
    - `nativeBuildInfo` parses `native.version()` and returns `BuildInfo`, or `null` without a module or on an error envelope.
    - `protocolRangeText` gives `"3"` when min equals max and `"3 to 5"` otherwise.
    - `about.tsx` adds "Core" (the version) and "Protocol" rows in the existing row style. Without a module, both read "Unavailable".
  - **`NativeCoreBridge`**: while the chosen transport is native (`isNativeTransport`), it calls `setDataPolicy({ sync_on_cellular })` from phone settings on mount and on every change, and does nothing on the demo transport.
    - Phone settings have no cellular toggle yet, so it reads `false` until phase 7 adds the toggle.
  - **`DebugScreen`**
    - A form with address, user, port, route and helper path, prefilled from `EXPO_PUBLIC_STATGLASS_DEBUG_{HOST,USER,PORT,HELPER}`.
    - It shows the `authorized_keys` line as selectable `Text`. expo-clipboard is not a dependency, and this phase adds none.
    - Connect starts the core with one `MacHelper` host, opens a live stream and shows the connection state and `cpu.usage`.
    - With no native module, it says the debug screen needs a development build.
    - It uses the shared `Text` roles and tokens. It is a developer screen and is never linked from the app's navigation.
- **Test cases:**
  1. `parseEnvelope` returns ok and error envelopes unchanged, and turns `"not json"` and `{"x":1}` into `internal` errors that quote the input.
  2. `getHost(id)` sends `("get_host", '{"host":"<id>"}')`, and `listHosts()` sends `("list_hosts", "null")`. Every seam method's method name is checked against the `MobileCall` union with a type-level test, so a renamed variant fails `tsc`.
  3. `subscribeLive` delivers two `onLive` payloads for its stream in order, ignores another stream's payload, and stops after `unsubscribe`.
  4. Two subscriptions get different stream ids, and an unsubscribed id is not reused.
  5. A `subscribe_live` error envelope rejects with that `CommandError` and leaves no callback.
  6. `toRemoteHostRecord` fills the desktop-only fields with their none values for a fixture, and the rest equals the input. The output type-checks as `RemoteHostRecord`.
  7. `RemoteHostsChanged` refetches and passes the hosts, and a failed refetch passes the error.
  8. `dispose` removes the `onLive` and `onCoreEvent` listeners (the fake module's listener count goes to 0).
  9. `nativeBuildInfo(null)` is `null`. `protocolRangeText` gives `"3"` and `"3 to 5"`.
  10. The About screen shows the core version and "3 to 5" with a fake module, and "Unavailable" without one.
  11. `NativeCoreBridge` calls `setDataPolicy` once on mount with a native transport and never with the demo transport.
  12. `DebugScreen` without a module shows the development-build message, and with a fake module shows the key line and, after Connect, the CPU value from a pushed frame.
- **Decisions already made:**
  - `RemoteHostRecord` stays the shape the screens read; the facade returns `MobileRemoteHost`.
  - Method names are `MobileCall`'s snake_case tags.
  - Stream ids are chosen in JS.
  - The debug screen is a hidden route reached by deep link.
  - Choosing the native transport for paired hosts is phase 7; `PhoneTransportProvider` is unchanged.
- **Out of scope:**
  - Swift and the native error parser (lane b).
  - Rust (lanes a and d).
  - `packages/core/src/remote-connection*.ts` (phase 5 lane c).
  - Pairing screens (phase 7).
- **Done when:** the conditions in the table are met.

#### Lane d brief

- **Goal:** Make the core behave like a phone app. It quiesces on background and resumes on foreground, picks the sync policy from the network path and the cellular setting, keeps the phone's mirrors within 250 MB in total, and signs with the native key.
- **Interface:** the scaffold's `Lifecycle`, `policy::{sync_policy, host_budget_mb}`, `NativeSignerAdapter` and `signer::authorized_key_line`, all over `SessionControl`. Extract lifecycle state into `lifecycle/` if needed.
- **Behavior:**
  - **`sync_policy(path, data)`**, the cellular SyncPolicy:

    | Path | `sync_on_cellular` | SyncPolicy |
    | --- | --- | --- |
    | `None`, or not expensive and not constrained | any | `Full` |
    | `expensive`, not constrained | true | `SummaryOnly` (M15 only) |
    | `expensive` | false | `Off` |
    | `constrained` (Low Data Mode) | any | `Off` |
    | not `satisfied` | any | unchanged from the last policy; the dialer finds no route anyway |

  - **`host_budget_mb(n)`** is `min(PHONE_MIRROR_HOST_MB, PHONE_MIRROR_TOTAL_MB / n)` for `n >= 1`, and `PHONE_MIRROR_HOST_MB` for 0.
  - **`Lifecycle`** keeps the last `NetworkPath`, `DataPolicy`, the policy it derived, and a backgrounded flag, under `statglass_schema::lock`.
    - `path_changed` and `set_data_policy` re-derive the policy and call `set_sync_policy` only when it changes.
    - `path_changed` also calls `network_changed(LocalNetwork { online: path.satisfied, ..statglass_session::network::probe() })`.
    - `quiesce` marks the core backgrounded, calls `quiesce()` on every source, and returns a future that resolves when all of them have. It resolves at once with no sources.
    - `resume` clears the flag and calls `resume()` on each source in `sources()` order, so the open host dials first.
    - A second `resume`, or a `resume` without a `quiesce`, is harmless; `RemoteSource::resume` is idempotent.
    - A `quiesce` while already backgrounded quiesces again, which covers sources started since.
  - **`NativeSignerAdapter`**
    - `new` reads `native.public_key()` once.
    - `sign` calls `native.sign` in `spawn_blocking`, because Swift may block on the Secure Enclave.
    - It maps `Unavailable` and `Unexpected` to `SignerError::Unavailable` and `Refused` to `SignerError::Refused`, keeping the message.
  - **`authorized_key_line`** is `statglass_ssh::authorized_key_line(&native.public_key(), comment)`, with `Invalid` mapped to `CommandError::Internal`.
- **Test cases:**
  1. `sync_policy` returns the value in the table for every combination of path (`None`, or each of `satisfied`, `expensive` and `constrained` on or off) and `sync_on_cellular`.
  2. `host_budget_mb` gives 25 for 0, 1 and 10 hosts, 22 for 11 and 1 for 250. For every n from 1 to 300, `n * host_budget_mb(n) <= 250`, and the result is never 0 for n up to 250.
  3. Under paused time, with a fake `SessionControl` holding real `RemoteSource`s over a failing fake dialer: `quiesce` resolves, and no dial happens while time advances 10 minutes.
  4. After `resume`, each source dials once at once, with the open host's dial first.
  5. `resume` twice dials once per source. `resume` with no `quiesce` before it does not drop a connected source.
  6. `quiesce` with no sources resolves at once. Ordering against an in-flight ingest belongs to `RemoteSource::quiesce` and is already covered by `statglass-session`'s `source/phone_tests.rs`; its fake host is crate-private, so this lane does not test it again.
  7. On an expensive path with `sync_on_cellular` off, `set_sync_policy(Off)` is applied. Turning the setting on applies `SummaryOnly`, and moving to Wi-Fi applies `Full`. Repeating the same path calls `set_sync_policy` once.
  8. `path_changed` calls `network_changed` with `online` equal to `satisfied`.
  9. `NativeSignerAdapter` over a fake native signer wrapping `SoftwareSigner` produces a DER signature that verifies with the public key. Each `NativeSignerError` maps to the `SignerError` variant above, keeping the message.
  10. `authorized_key_line` matches `SoftwareSigner::authorized_key_line` for the same key, and a 64-byte public key gives `internal`.
- **Decisions already made:**
  - The cellular SyncPolicy is the table above; `SummaryOnly` means M15 only.
  - The total is split evenly across hosts (RFC 5: 25 MB per host, 250 MB in total).
  - The open host resumes first.
  - Live data on cellular (`liveOnCellular`) is not restricted in this phase.
- **Out of scope:**
  - How sessions are kept and rebuilt (lane a; it calls `host_budget_mb`).
  - The Swift notifications and `NWPathMonitor` (lane b).
  - RFC 4.4's 7-day cellular cap on the first M15 sync, which needs a session floor override (follow-up).
  - The concurrency cap and rotation (phase 7).
- **Done when:** the conditions in the table are met.

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
Scaffold: 8a2ce900
Tag: ios-app-phase-5
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
- Adding the pairing line appends `restrict,expiry-time="YYYYMMDDHHMMSS",command="<abs> pair --nonce <n>" ecdsa-sha2-nistp256 <b64> statglass-pairing:<n>`, in the host's system local time (no `Z`: OpenSSH reads unsuffixed times in the system zone back to 7.7, and the suffix needs 9.1). The `pair` nonce check against the true instant stays authoritative.
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
| a | L | crates/statglass-remote/src/scope.rs, crates/statglass-remote/src/scope/, crates/statglass-remote/src/server.rs, crates/statglass-remote/src/stdio.rs, crates/statglass-remote/src/host_server.rs, crates/statglass-remote/src/device_seen.rs, crates/statglass-remote/src/authorized_keys.rs, crates/statglass-remote/src/authorized_keys/, crates/statglass-remote/tests/restricted.rs, crates/statglass-remote/tests/authorized_keys.rs, crates/statglass-remote/tests/docker_restricted.rs, crates/statglass-remote-helper/src/main.rs, crates/statglass-remote-helper/src/restricted.rs, crates/statglass-remote-helper/src/markers.rs, crates/statglass-agent/src/restricted.rs, crates/statglass-agent/src/daemon.rs, crates/statglass-agent/src/devices.rs, crates/statglass-agent/tests/restricted.rs, crates/statglass-agent/tests/devices.rs, Cargo.lock, crates/statglass-remote/Cargo.toml, crates/statglass-remote-helper/tests/restricted.rs | contracts, RFC 2.3, 2.5, 2.6, 3.2 | scope, preface, token table, markers, authorized_keys, Docker restricted and sshd key tests | gpt-6.2-sol | merged | foreman/ios-p5a | `cargo test -p statglass-remote -p statglass-remote-helper -p statglass-agent` pass; `make ssh-docker-test` passes `docker_restricted`; clippy clean |
| b | L | crates/statglass-remote/src/pairing.rs, crates/statglass-remote/src/pairing/, crates/statglass-remote/tests/pairing.rs, crates/statglass-proto/src/pairing.rs, crates/statglass-proto/src/pairing/, crates/statglass-session/src/pairing.rs, crates/statglass-session/src/pairing/, crates/statglass-remote-helper/src/pair.rs, crates/statglass-agent/src/pair.rs, crates/statglass-agent/src/pair/, crates/statglass-agent/tests/pair.rs, crates/statglass-ssh/tests/docker_pair.rs, crates/statglass-ssh/Cargo.toml, crates/statglass-remote/src/socket.rs, crates/statglass-session/src/error.rs, crates/statglass-session/src/network.rs, crates/statglass-session/src/source/status.rs, crates/statglass-ipc/src/error/remote.rs, src-tauri/src/query/map.rs | contracts, RFC 2.4 | payload codec, approval state machine with a fake `DeviceKeys`, forced side, agent interactive pair, Docker approve/deny | gpt-6.2-sol | merged | foreman/ios-p5b | `cargo test -p statglass-proto -p statglass-remote -p statglass-session pairing` and `cargo test -p statglass-agent pair` pass; `make ssh-docker-test` passes `docker_pair` once lane a is merged |
| c | L | src-tauri/src/pairing.rs, src-tauri/src/pairing/, src-tauri/src/remote/server.rs, src/app/routes/dashboard/settings/route.tsx, src/app/routes/dashboard/settings/_components/paired-devices/, src/desktop-transport/native-pairing.ts, src/desktop-transport/app-transport.ts, packages/core/src/mock/pairing.ts, packages/core/src/remote-errors.ts, packages/core/src/remote-connection.ts, packages/core/src/remote-connection-network.ts, tests/e2e/settings-pairing.spec.ts | contracts, RFC 2.3, 2.4, 2.6, 3.2, plan/design-system.md | src-tauri pairing tests, Vitest panel/sheet/mock, Playwright settings | gpt-6.2-sol | merged | foreman/ios-p5c | `cargo test -p statglass pairing`, `bun run typecheck`, `bun run test` and `tests/e2e/settings-pairing.spec.ts` pass; screenshot compared to Remote monitoring |

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
Tag: ios-app-phase-6

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
| a | M | apps/mobile/src/app/demo.tsx, apps/mobile/src/app/(hosts)/index.tsx, apps/mobile/src/app/settings/, apps/mobile/src/data/hosts.ts, apps/mobile/src/hosts/, apps/mobile/src/lock/, apps/mobile/test/hosts/, apps/mobile/test/settings/, apps/mobile/test/first-launch.test.tsx, apps/mobile/src/data/transport-context.tsx, apps/mobile/src/data/demo.ts | contracts, RFC 1.4 | mobile hosts/settings tests | gpt-6.2-sol | merged | foreman/ios-p6a | mobile tests pass; simulator screenshots of the hosts list and settings |
| b | M | packages/core/src/widget-models/stream-area.ts, packages/core/src/widget-models/gap-band.ts, packages/core/src/widget-models/chart-annotation.ts, packages/core/src/widget-models/charts.test.ts, src/app/widgets/stream-area.tsx, src/app/widgets/gap-band.tsx, src/app/widgets/chart-annotation.tsx, apps/mobile/src/widgets/stream-area.tsx, apps/mobile/src/widgets/gap-bands.tsx, apps/mobile/src/widgets/chart-annotations.tsx, apps/mobile/test/widgets/charts/, apps/mobile/src/widgets/lib/stream-motion.ts, apps/mobile/src/widgets/lib/stream-scan.tsx, packages/core/README.md | contracts, .claude/skills/widget-model/, RFC 4.6 | read-only: src/app/widgets/{stream-area,gap-band,chart-annotation}.test.tsx, src/app/routes/popover/ (tests) | gpt-6.2-sol | merged | foreman/ios-p6b | core, desktop and mobile chart tests, gallery e2e and e2e-perf pass |
| c | M | packages/core/src/widget-models/stack-bar.ts, packages/core/src/widget-models/inline-bar.ts, packages/core/src/widget-models/meter-track.ts, packages/core/src/widget-models/mirror-bars.ts, packages/core/src/widget-models/bars.test.ts, src/app/widgets/stack-bar.tsx, src/app/widgets/inline-bar.tsx, src/app/widgets/meter-track.tsx, src/app/widgets/mirror-bars.tsx, apps/mobile/src/widgets/stack-bar.tsx, apps/mobile/src/widgets/inline-bar.tsx, apps/mobile/src/widgets/meter-track.tsx, apps/mobile/src/widgets/mirror-bars.tsx, apps/mobile/src/widgets/stat-list.tsx, apps/mobile/src/cards/, apps/mobile/test/widgets/bars/, apps/mobile/test/cards/ | contracts, .claude/skills/widget-model/, popover-cards.tsx | read-only: src/app/widgets/{stack-bar,inline-bar,meter-track,mirror-bars}.test.tsx, src/app/routes/popover/ (tests) | gpt-6.2-sol | merged | foreman/ios-p6c | core, desktop and mobile bar and card tests, gallery e2e and e2e-perf pass |
| d | M | apps/mobile/src/data/live.ts, apps/mobile/src/data/live-stream.ts, apps/mobile/src/data/history.ts, apps/mobile/src/host/, apps/mobile/src/module/, apps/mobile/test/host/, apps/mobile/test/module/, apps/mobile/src/data/live-subscription.ts | contracts, src/app/stores/host-store.tsx, src/app/hooks/use-compact-stream.ts | mobile host/module tests | gpt-6.2-sol | merged | foreman/ios-p6d | mobile tests pass; simulator screenshots of the host screen and a module page |

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
  - The empty list shows an explanation with "Try demo hosts" and "Pair with your Mac". (Superseded 2026-11-25 by the user's one "Add a host" flow, phase 7.)
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

### Phase 7: foundation for pairing and polish

Demo:
- **Simulator, demo hosts:** `/demo?scenario=phone-errors` lists one host per RFC 3.2 failure, and each shows its own sentence and action on the hosts list and the host screen, for example "StatGlass isn't running on studio", "This iPhone is no longer authorized on build", "Update StatGlass on nas". An offline host shows dashes in its row and no frozen reading. Headers follow the theme in dark mode, and the module title is legible.
- **Rust:** the facade test runs a full session through `MobileCore` without Docker (subscribe, frame, quiesce, resume, frame) and shows a refused key as a typed envelope.
- **Docker host:** `NetworkAddresses` returns the container's interface, link speed and addresses, with `pending` for the public IP on the first ask and the IP (or `unavailable` with the reason) on the next.
- **History from the host:** against the Docker agent, the module page's 1 h, 24 h, 7 d and 30 d charts come from `Query::History`, with the stat strip's avg and peak and the module's events in the same answer. The phone's data directory has no `mirrors/` folder, and Settings > Data has one switch, "Live updates on cellular". A host built before the feature shows "Update StatGlass on <host> to see history" on the chart while its live values keep ticking.
- **Logs:** a failed session open appears in Console.app under subsystem `app.statglass` (simulator log stream).
- **Desktop:** the popover renders the same card wording from the shared card models. Its screenshots and gallery are unchanged.

Depends on: phase 6

Why a phase of its own, not folded into the pairing scaffold: the audits (`audit-architecture.md` F1-F4, `audit-errors.md` H1-H4, `audit-tests.md` High) touch the files that pairing's lanes build on. Those are the native transport, the root layout, the data hooks, the connection status wording, `remote-errors.ts`, the session status and the host row. Folded into one scaffold they would make the scaffold an L-sized job run serially before any lane. Folded into the pairing lanes, they would give several lanes the same file. As a phase, they fan out as thirteen disjoint lanes, and pairing (phase 8) starts on settled seams: one core owner, typed failures, one live-session policy and one status wording. The user's decision that the phone keeps no history (D-152: the host answers every history read) lands here too, because every chart and the demand lane build on it.

Source: the three audits of 2026-11-25 (copied into the Log entry of that date). Items not landed here are assigned to a later phase or deferred in `plan/rfc-ios-polish.md` section 9, "Audit items: placement".

Code facts this phase relies on (checked 2026-11-25):
- **The debug screen owns the core.** The only code that starts the Rust core is `openDebugCore`/`getDebugCore` in `apps/mobile/src/transport/native-transport.ts`, a module-level `WeakMap`. The debug screen reimplements status polling and live reduction in `apps/mobile/src/debug/use-debug-connection.ts`.
- **No navigator theme.** No `ThemeProvider` exists. Header colors are set by hand in `(hosts)/index.tsx`, `settings/_layout.tsx` and `debug/debug-screen.tsx`, and every other screen gets React Navigation's light theme.
- **The live state machine exists twice and has drifted.** Desktop `src/app/stores/host-store.tsx` and phone `apps/mobile/src/data/live-subscription.ts` each implement it:
  - catch-up after 120 s on the desktop, 60 s on the phone;
  - the phone stops on six terminal error kinds, the desktop retries forever.
- **Rust logs go nowhere.** `statglass-mobile` has `tracing` but no subscriber.
- **A failed host open is reported as the wrong error.** An unopened host returns `UnknownHost` (`sessions/registry.rs:304-311`) while its typed open error sits in `open_errors`. `vitals()` returns the last frame after a disconnect (`sessions/host.rs:171-177`).
- **Native errors lose their type, and one case is a guess.** Native rejections flatten to `internal` (`transport/envelope.ts:83-100`), and `isCommandError` accepts any `{ kind }` (`packages/core/src/command-error.ts`). The Swift side throws only `keychain`/`secureEnclave`. `publicKey()` returns empty `Data()` when the key is missing, which reads as an authentication failure.
- **Card content is written twice.** Desktop `src/app/routes/popover/_components/popover-cards.tsx` and `apps/mobile/src/cards/*` each define segments, swatches and wording. `describeStats` exists only on the phone.
- **The phone has two wordings for connection state.** `apps/mobile/src/data/hosts.ts` adds `clock_offset_ms` to a `last_seen_ms` that Rust already converted to the host clock. `host/connection-pill.tsx` doesn't add it.
- **The phone mirrors history.** `sessions/host.rs:69-114` opens a `HistoryStore` under `mirrors/<id>` for each host and hands a `Mirror` to its `RemoteSource`. `policy.rs` turns the network path and `DataPolicy.sync_on_cellular` into a `SyncPolicy` and splits `PHONE_MIRROR_TOTAL_MB` across hosts (`MobileRemoteHost.mirror_budget_mb`). `MobileCall::QueryHistory` and `QueryEvents` read the mirror. `StatglassNativeModule.swift:140` marks it `isExcludedFromBackup`. In `statglass-session`, `SyncPolicy`, `MirrorPolicy::phone` and `PHONE_MIRROR_*` are used only by the phone: `src-tauri`, `statglass-remote` and the agent never reference them. The TS setting `liveOnCellular` is read by nothing (tests audit M7). `syncOnCellular` is the only cellular setting pushed to Rust (`native-core-bridge.tsx:14-38`).
- **Bounded history reads exist.** `statglass_ipc::query_history` builds a `statglass_store::HistoryQuery` with `max_points` and reads it through `HistoryStore::history_through_now`. The store merges whole buckets per slot to stay under `max_points` and keeps avg, min and max (`slots.rs`, `disk_io.rs:110-117`). `statglass_store::range_stats` (`reader/stats.rs:35`) gives avg and peak per metric from a read, pooling every series of the metric (`reader/stats.rs:50` filters by `key.metric`), so it can't give a per-interface or per-core figure as is. Tier rows are one blob per `(host_id, bucket_ts, layout_id)`, found through the unique index `tier_10s_key`/`tier_1m_key`/`tier_15m_key` (`db.rs:77,87,183`). An M15 read also takes the minutes still in `tier_1m` (`db.rs` `bucket_sources`/`bucket_rows_sql`), and the reader's SQL (`reader.rs:218`) has no layout filter, so today it reads every layout's rows. Tier retention and the pruned marks live in `reader/tiers.rs`. `history_through_now` merges a `recent` closure's rows after the read. The writer commits every 5 minutes (`DEFAULT_COMMIT_INTERVAL`), so persisted rows alone end up to 5 minutes before now. `HostServer::recent` (`crates/statglass-remote/src/host_server.rs:121-127`) already bounds the hub's recent rows to the last 5 minutes, and `statglass_engine::RECENT_ROWS_MS` (`accum.rs:37`, 15 minutes) is how long the hub keeps them. `statglass-remote` can't depend on `statglass-ipc`, so the host calls the engine and store functions directly.
- **Events cross the wire as rows.** `Answer` events are `statglass_proto::WireEvent` (`message.rs:298`, `kind` a string and the payload a CBOR blob). `EventDetail` has no `Unknown` variant on purpose (`statglass-schema/src/event.rs:31-36`): a newer kind fails to decode and the reader skips the row.
- **Proto enums that must survive a newer peer** are adjacently tagged with an `Unknown` variant and decoded through `Tagged`/`lenient` (`crates/statglass-proto/src/query.rs:78-82`).
- **Queries already run off the session loop.** `answering.rs` answers every `Query` on `spawn_blocking` as soon as it arrives (no queue), with at most `MAX_IN_FLIGHT = 8` per session and `ErrorCode::Busy` beyond that. `HostServer` (`host_server.rs:61`) holds the per-host state the server shares across sessions. `HistoryStore` pools idle readers (`MAX_IDLE_READERS = 2`, `history_store.rs:17`) but doesn't cap concurrent checkouts. Hosts advertise features in Hello (`handshake.rs:87`, for example `query.usage-history.v1`). `CommandError::RemoteUnsupported` and `RemoteBusy` exist.
- **The phone still needs `statglass-store` without a mirror.** `sessions/phone_id.rs` uses its `WriterLock` and `create_private_dir` for the phone identity, so the direct edge stays in `crate-edges.json`. `statglass-ipc` depends on the store too.
- **The facade has no dialer seam.** `Sessions::start` builds `RusshDialer::new(signer)` itself (`crates/statglass-mobile/src/sessions.rs:58`), and `MobileCore::new` takes only the signer and events. The crate's unit tests already have fake dialers (`sessions/tests/mod.rs`, `lifecycle.rs:227`). `crates/statglass-ssh/tests/support/server.rs` is an SSH server that speaks no StatGlass protocol, and `statglass-mobile` can't depend on `statglass-remote` (`crate-edges.json`). The end-to-end facade test is the Docker one, `tests/mobile_session.rs` `mobile_core_streams_and_reads_its_mirror`, run by `scripts/ssh-docker/run.sh:133`.
- **The phone calls into the mirror from many files.** `MirrorPolicy::phone`, `SyncPolicy`, `set_sync_policy` or `PHONE_MIRROR_*` appear in `crates/statglass-mobile/src/{control,lifecycle,policy,sessions}.rs`, `sessions/host.rs:88`, `sessions/registry.rs`, `sessions/registry/tests.rs`, `sessions/tests/{history,live,mod,registry}.rs`, and in `crates/statglass-ipc/tests/phase3_gate.rs` (`MirrorPolicy::phone`, `PHONE_MIRROR_HOST_MB`).
- **The phone's recent-rows interest is dead.** `MobileCall::SetHostsRecentInterest` reaches `Registry::set_recent_interest` (`sessions/registry.rs:347,463`), but no phone hook calls `setHostsRecentInterest`; only `test/transport/transport.test.ts` does.
- **The catch-up window is a Rust constant TS copies.** `statglass_ipc::live::RECENT_MS = 120_000` (`live.rs:103`) is what `subscribe_live` sends before returning. `SubscriptionInfo` doesn't carry it, so `src/app/stores/host-store.tsx:108` copies 120 s and the phone uses 60 s.
- **The phone has no process interest call.** `MobileCall` has no `SetProcessInterest`; the desktop's is `set_process_interest(host, interested, view, stream)` (`src-tauri/src/commands.rs:109`) over `LiveRegistry::set_process_interest`.
- **Host addresses.** The engine's collectors have `interface_addresses`/`egress_interface` for macOS and Linux. `src-tauri/src/addresses.rs` reads the public IP with `/usr/bin/curl` from `api.ipify.org` (D-093). The protocol has no addresses query. The restricted scope (`crates/statglass-remote/src/scope.rs`) refuses every `Query`.

Test cases:

**Core owner and app shell (lane a)**
- `CoreProvider` in the root layout:
  - It starts the native core once per app run and exposes `{ core, error }`.
  - When `listHosts` is non-empty it selects the native transport.
  - It disposes the core on unmount.
  - A start failure renders its typed error with Retry.
  - Under jest it uses `FakeNative`.
- Getting the core:
  - `useNativeCore()` returns the same instance to the debug screen and the data hooks.
  - `debugCores`, `openDebugCore` and `getDebugCore` are gone. The debug screen renders from `useHostLiveSubscription`/`useRemoteStatus` and passes its existing tests.
- Theme:
  - The navigator theme comes from `themeColors` for each scheme, so switching to Dark recolors the host and module headers.
  - No screen sets `headerTintColor` or `headerUserInterfaceStyle` (asserted by a grep test in `test/navigation/`).
  - `useThemeColors()` replaces the 20 direct lookups.
- Root layout:
  - `GestureHandlerRootView` wraps the root once, and `ModuleHistory` no longer mounts one.
  - `ErrorBoundary`, exported from the root layout, renders a retry action and logs the route params once.
- Routes and cache:
  - Opening `/(hosts)/<id>` with no transport replaces to `/`, not to Expo's error screen.
  - Swapping transports clears host and history queries inside `PhoneTransportProvider.set`. `demo.tsx` no longer clears the cache by hand.
  - `/demo?scenario=<name>` passes the scenario to `createMockTransport`.
- Query retry is driven by error kind: `unknown_host`, `store_too_new` and `invalid_argument` are not retried, `internal` is retried once.
- `AppProviders` is exported once and used by both `_layout.tsx` and `test/render.tsx`.

**Boundaries and tooling (lane b)**
- Biome:
  - Importing `@native/statglass-native` outside `apps/mobile/src/transport/**` fails.
  - `apps/mobile/src/widgets/**` and `apps/mobile/src/cards/**` importing `@/data`, `@/transport`, `expo-router` or `@tanstack/*` fails.
  - Each rule has a positive and a negative fixture in `scripts/architecture/test_biome_rules.py`.
  - The hook (`.claude/hooks/enforce-boundaries.sh`) has the same native rule.
- `setSnapshotCover` moves behind `apps/mobile/src/transport/device.ts`. `test/native/snapshot-cover.test.tsx` uses `FakeNative`/`installNative`, with no `jest.mock` of the native module anywhere (grep test).
- The native module exports a test seam from its `index.ts`, so `fake-native.ts` stops deep-importing.
- Jest and checks:
  - `testTimeout` drops to 5000 ms.
  - One `mockAppState()` helper replaces the three hand-rolled stubs.
  - `scripts/mobile/check.sh` runs `expo-doctor`.
  - `lib: ["DOM"]` is removed from the mobile tsconfig if typecheck passes without it; otherwise the lane reports which type needs it.
- Docs: `.claude/rules/mobile/expo.md` lists `src/debug/` and `@native/*`. `.claude/rules/rust/crates.md` lists the real `statglass-mobile` edges.

**Live session policy (lane c)**
- `createLiveSession` in `packages/core/src/live-session.ts`:
  - It owns retry, stale, backoff, catch-up and terminal state, with one set of constants.
  - Under a fake clock it reproduces the desktop's current tests: `src/app/stores/host-store.test.tsx` and `host-store-live.test.tsx` pass unchanged.
- Catch-up threshold:
  - One threshold for both apps, taken from the subscription's recent window.
  - If Rust doesn't publish that window, the lane adds `recent_ms` to `SubscriptionInfo`, and the desktop and phone stop hardcoding 120 s and 60 s.
- Terminal state: both apps keep backing off. "Stop retrying" comes from `RemoteHostStatus` (state `error` with a terminal failure kind), never from a local list of `CommandError` kinds. That list is deleted (errors audit L1).
- Phone adapter: it maps focus and `AppState` to `isVisible`. It reaches stale, then "Reconnecting", then a fresh frame through the shared session, tested with fake timers.
- `connectionStatusError` no longer routes a local call through `remoteQueryText` (errors audit L5).

**Session and IPC errors (lane d)**
- `RemoteError::IncompatiblePeer` carries `side`:
  - `Host` when the peer's max is below our min, `App` when the peer's min is above our max.
  - `ConnectionStatus.incompatible_side` and `RemoteConnection.incompatible_side` carry it.
- A panic in a source task publishes `state: error` with failure kind `internal` and logs once, instead of freezing the last status (M3).
- `RemoteError::Refused` maps to `CommandError::RemoteRefused { message }` with tone `status` (M7).
- The agent's restricted refusal ("command not allowed") prints a marker that the phone maps to `incompatible` (L7).
- `StoreError` keeps its source chain in the message (L8).
- The query refusal text no longer says "this Mac" on a phone (L5).
- The phone-only mirror code leaves `statglass-session`: `SyncPolicy`, `RemoteSource::set_sync_policy`, `MirrorPolicy::phone`, `PHONE_MIRROR_HOST_MB`/`PHONE_MIRROR_TOTAL_MB`, and the sync cases in `source/phone_tests.rs`. `crates/statglass-ipc/tests/phase3_gate.rs` drops its `MirrorPolicy::phone` and `PHONE_MIRROR_HOST_MB` cases. The desktop mirror, `MirrorPolicy::desktop` and their tests don't change: `cargo test -p statglass-session -p statglass-remote` and `cargo test -p statglass remote` pass with unchanged assertions. The scaffold already removed every phone call into this code, so the deletion compiles while lane i runs.

**Phone core without a mirror (lane i)**
- No mirror:
  - Opening a host creates no directory under `mirrors/` and opens no `HistoryStore` (a temp-dir test lists the data directory after start).
  - `RemoteSource` is built with no mirror.
  - `policy.rs` keeps one rule, `live_allowed(path, data)`: false on an expensive or constrained path when `live_on_cellular` is off. Phase 8 lane d applies it to demand.
  - `mirror_budget_mb` and the storage split are gone.
- Unopened hosts (H2, reshaped by D-152):
  - With no store, opening a host can't fail on a corrupt, too-new or locked store, and those tests are deleted.
  - `entry()` for a desired host whose source hasn't started returns that host with state `connecting`, never `unknown_host`.
  - A host whose start fails (an invalid endpoint, an unavailable signer) carries `MobileRemoteHost.open_error`.
- Vitals when disconnected (H4): `vitals()` returns empty readings with `as_of_ms` set to the last frame's time. A connected host returns current readings with `as_of_ms` set to now.
- Quiesce: `quiesce()` closes sessions and resolves without waiting on any mirror write. The lifecycle test asserts it resolves within one runtime turn under paused time.
- History client: `MobileCall::HostHistory(HostHistoryRequest)` forwards to the session's `Query::History`.
  - A host without `query.history.v1` returns `CommandError::RemoteUnsupported` without sending anything.
  - `Busy` maps to `CommandError::RemoteBusy`.
  - A disconnected host returns `RemoteUnreachable` at once, with no queued retry.
  - `sessions/history.rs` converts each `WireEvent` to an `Event`; one whose kind this build doesn't know is skipped and the others are kept (a test with a future kind). A `HistoryClamp::Unknown` passes through as `unknown`.
- The core holds no history between calls: after an answer is returned, no per-host buffer remains (a test inspects `Sessions` after a call). Phase 8 lane d proves the same after `PARK_GRACE`.
- `Registry::set_recent_interest` and its `recent` field are gone (the scaffold removed `MobileCall::SetHostsRecentInterest`; no phone hook ever called it).
- `envelope::panicked` logs once (a test with a capturing subscriber).
- Docker (`tests/mobile_session.rs`, `--ignored`): `mobile_core_streams_and_reads_its_mirror` becomes `mobile_core_streams_and_reads_host_history`. Through `MobileCore` with a software native signer it streams a live frame from the container's agent, then makes one `host_history` call answered by the agent's store, and asserts the data directory has no `mirrors/`. `scripts/ssh-docker/run.sh` names the renamed test. This is the end-to-end facade test (tests audit M8); it runs in this phase's Docker demo and again in phase 8's verification.

**Logging and the facade test (lane l)**
- Logging (H1):
  - `MobileCore::new` installs a tracing subscriber once, an os_log layer with subsystem `app.statglass`. A second `new` in the same process doesn't panic.
  - Errors are recorded as `error = &e as &dyn Error`.
- Facade unit test (`crates/statglass-mobile/src/facade_tests.rs`, `#[cfg(test)]`, tests audit M8): it builds the core with the scaffold's test-only `MobileCore::with_dialer` and the scripted `PeerDialer` from `sessions/tests/`, so it runs the real facade, envelope and session code with no network.
  - It runs `start`, `subscribe_live`, a frame, `quiesce`, `quiesced`, `resume` and a frame, then one `host_history` call that the scripted peer answers with a fixed `Answer::History`, and checks the JSON envelope of each.
  - A dial that fails with `RemoteError::Authentication` returns an error envelope with the `remote_auth` kind.
  - The real russh and agent path is lane i's Docker test, not this one: the in-process SSH server in `statglass-ssh/tests/support/` speaks no StatGlass protocol, and the facade can't depend on `statglass-remote` for a real server.

**Native errors (lane e)**
- `NativeError` (`{ source: "native", kind, osStatus, message }`) has its own discriminant. `isCommandError` rejects it, and `nativeErrorText` words each kind ("Unlock this iPhone to connect" for `errSecInteractionNotAllowed`).
- `callCore` keeps a native rejection typed instead of flattening it to `internal`.
- The facade surfaces a missing key:
  - `NativeSigner::public_key` becomes fallible in the UniFFI trait.
  - `errSecItemNotFound` and `errSecInteractionNotAllowed` map to a `phone_key_unavailable` failure kind, distinct from `authentication` (errors audit M2).
- Swift constructs `.localNetwork` where the dialer sees `EHOSTUNREACH` on a LAN target with Local Network denied, or the case is deleted. The lane reports which.
- A Swift test package (`apps/mobile/modules/statglass-native/ios-tests/`, `swift test`) checks the `NativeFailure` codes and the "(OSStatus N)" message against the same strings `test/native/native-error.test.ts` parses.
- The mirror's `isExcludedFromBackup` block in `StatglassNativeModule.swift` is deleted (D-152). No mirror directory exists to exclude.
- `callCore` gets a typed result table keyed by method (architecture M11). `parseEvent` warns once per stream, not per message. `build-info.ts` logs the error envelope it drops.

**Connection states (lane f)**
- `phoneProblem(record, nowMs)` covers each row of the RFC 3 coverage table in `plan/rfc-ios-polish.md`. It returns kind, title, short text, recovery, action and tone, in phone wording, and `null` while connected.
  - The input is `failure_kind`, `route_failures`, `incompatible_side`, `identity_changed`, `open_error` and `last_seen_ms`.
  - It never reads the `error` text.
- One `hostStatusSummary(status, { now })` drives the hosts-list status line, the pill and the module page. Times are converted once, following the epoch Rust documents for `last_seen_ms`. A test with a non-zero `clock_offset_ms` asserts the same time on every screen.
- The hosts list:
  - shows the problem's short text beside "Needs attention";
  - shows an offline host with dashes, no chart and "Offline since HH:MM" in host time, never its last readings (D-152: there is no history behind them, and errors audit H4 found stale values reading as live);
  - shows one "This iPhone is offline" line when every host reports `waiting_for_network`, and "Retrying at HH:MM" from `next_attempt_ms`.
- The host page shows a banner with title, recovery and action:
  - Re-pair pushes `/pair`.
  - Retry calls `retryRemoteHost`.
  - Open Settings calls `Linking.openSettings()`.
  - Open Tailscale calls `tailscale://`, with a fallback message.
- Fixtures:
  - The `phone-errors` scenario seeds one host per table row.
  - `failNext(method, error)` on the mock transport injects command failures.
  - The 22 per-test response overrides in `hosts-list`, `host-screen` and `module-screen` tests move to these fixtures. Spies that only count calls stay.
- Offline assertions use the exact strings from `last_seen_ms` (tests audit M5, M6). The `getQueryState` assertions in `module-screen.test.tsx` go (tests audit M3).

**Card content models (lane g)**
- `packages/core/src/popover/cards/{cpu,memory,gpu,power,network,battery}.ts` each return `{ title, headline, segments, items, bars, spoken }` from a selection and source. They are tested once against `widget-models/fixtures`.
- `describeStats` moves to `widget-models/stat-list.ts`.
- The desktop `popover-cards.tsx` and the phone cards render the models. Desktop popover tests, the gallery spec and the render-count specs pass unchanged, and `make e2e-perf` is reported before and after.
- `WidgetAccent` moves to `apps/mobile/src/widgets/accent.tsx`.
- `popover-cards.test.tsx` drops its `StreamArea` export spies and asserts accessible values instead (tests audit M1).

**Host addresses on the wire (lane h)**
- Codec:
  - `Query::NetworkAddresses` and `Answer::NetworkAddresses(HostAddresses)` round-trip.
  - Skew test 1: a new client asking an old host gets `Query::Unknown`, then `ErrorCode::Unsupported`, which the client maps to "Addresses are not available from this host".
  - Skew test 2: an old client never sends the query, and a new host decodes old messages unchanged.
  - Skew test 3: an answer carrying a `PublicIp` state this build doesn't know (`{"state": "via_stun", ...}`) decodes as `PublicIp::Unknown`, and the rest of `HostAddresses` decodes unchanged.
- `SessionScope::Restricted` allows `NetworkAddresses`, and every other `Query` is still refused (`crates/statglass-remote/tests/restricted.rs`).
- Host answer:
  - The interface comes from the egress interface, falling back to the primary.
  - The host also sends link speed when known, IPv4 and non-link-local IPv6, and `public_ip`.
- Public IP follows D-093 as widened by D-153 (tests drive the resolver with a fake clock and a counting curl runner):
  - Every host looks it up itself, Linux agents included. It is asked only on demand (a client's `NetworkAddresses`) and only after the local read succeeds; with no client asking, nothing runs (zero spawns over a fake hour).
  - It goes through `/usr/bin/curl` to `api.ipify.org` with a 5 s timeout. A host without `/usr/bin/curl` answers `PublicIp::Unavailable { reason: "curl not installed" }`.
  - Cold cache: the first request answers `Pending` at once and starts one lookup; the answer never waits on curl. A request while that lookup runs starts no second one.
  - Cache hit: a second request 23 h 59 min after a successful lookup spawns nothing and answers `Known`. A request after 24 h looks up again.
  - Network change: a changed local address, primary interface or egress interface makes the next request look up again inside the 24 h.
  - Failure TTL: a failed lookup answers `Unavailable` with the reason for 10 minutes, with no retry before then (one spawn across requests at 1 s intervals for 9 minutes), and looks up again on the first request after.
  - The public IP is never in a live frame or `HostSummary`: only `Answer::NetworkAddresses` carries it.
- The Mac app and the agent share one resolver. `src-tauri/src/addresses.rs` delegates to it.
- The phone's `MobileCall::NetworkAddresses { host }` returns the answer. The mock serves fixed addresses for demo hosts and `unavailable` for the Linux demo host.

**History read path (lane j1)** (D-152)
- Codec:
  - `Query::History` and `Answer::History` round-trip.
  - Skew (`crates/statglass-proto/tests/history_skew.rs`): an old host decodes the query as `Query::Unknown` and answers `Unsupported`; an old client never sends it; a new host decodes every pre-change fixture unchanged.
  - A future event kind: an answer whose `events` hold a `WireEvent` with a kind this build doesn't know decodes with that event intact as a row (lane i's conversion skips it on the phone).
  - A future clamp: an answer whose `clamped` holds a `HistoryClamp` this build doesn't know decodes it as `HistoryClamp::Unknown`.
  - `query.history.v1` is in `local_features()`.
- The restricted session answers `History`, and every other refused query stays refused (`tests/restricted.rs`, which the scaffold extends).
- Seed (`crates/statglass-remote/tests/support/history_seed.rs`): `seed_by_retention` writes, through the store's own `Writer`, S10 for the last day, M1 for the last 7 days and M15 for 30 days, for 40 series in several layouts (two of them per-interface `net.rx`/`net.tx`, and 64 `cpu.load{core}` series in their own layout). Writing by retention keeps the temp database small and makes reads cross the M15 and `tier_1m` union.
- Bounds (`crates/statglass-remote/tests/history_query.rs`, on that seed):
  - 30 days of 20 series at a 200-point budget: the answer has at most 200 points per series and 4,000 in total, and its encoded size is under 160,000 bytes. A point encodes to about 27 to 36 bytes (an i64 time and three floats), so 4,000 points take about 110 to 145 KB. The bound is on bytes on the wire after downsampling, not on rows read.
  - The same request at 7 days and at 30 days encodes to sizes within 5 % of each other.
  - A 5,000-point budget comes back with 500 points per series and `clamped` listing `points`. 40 series come back as 32, with `series` listed. An answer over `HISTORY_MAX_ANSWER_BYTES` halves its points until it fits, and lists `bytes`.
  - The heatmap request: 64 `cpu.load{core=*}` selectors at a 60-column budget come back as 64 series (`HISTORY_MAX_CORE_SERIES = 256` applies, not 32). 300 come back as 256 with `series` listed. A per-core request mixed with any other metric gets the 32 clamp.
  - An inverted range, an empty selector list, or a selector whose metric the catalog doesn't know: `InvalidArgument`. A known selector with no rows in range comes back with no points and the gaps over the range, not an error.
- Tier choice (`tier_for_budget`, a table test): 1 h at 200 picks S10; 24 h picks M1; 7 d and 30 d pick M15. A range starting before S10's retention moves to M1, never to a finer tier. Retention comes from the pruned marks in `reader/tiers.rs`.
- Reads:
  - The reader's SQL filters `layout_id IN (...)` to the layouts holding the requested series. A counting reader asserts the rows read for a 30-day M15 request are at most about 2,200 M15 rows plus 10,080 M1 rows per requested layout, and that a layout holding no requested series is never read or decoded.
  - The filter is computed in the reader from the query's selectors, so every read gets it, the desktop's `query_history` included. The store's existing history tests pass unchanged.
  - Recent rows: the read goes through `HistoryStore::history_through_now` with a `recent` closure over the hub's recent bucket rows for the host, bounded to `[max(from, now - RECENT_ROWS_MS), min(to, now)]`. A test with rows written but not committed asserts the answer reaches the last closed bucket before now (no 5-minute hole), and a closure that records its arguments asserts it is called once with that bound. `complete_to_ms` comes from the same snapshot.
- Content:
  - Gaps overlapping the range are included, and nothing is interpolated.
  - `stats` are per series key: each requested key's avg and peak equal `range_stats` over a read holding only that key. Two `net.rx` interfaces get two entries, never one pooled figure.
  - Events are those whose `EventDetail::module()` matches the request's module:
    - `power_spike`, `fans_ramped` and `thermal_state` go to Power & Sensors;
    - `sustained_process` goes to CPU;
    - `alert` goes to its rule's metric's module.
  - A Network request on a fixture holding an ANE `power_spike` returns no events.

**History concurrency and CPU (lane j2)** (D-152)
- Per-session queue (`answering.rs`; today every query is spawned as it arrives):
  - One history query runs per session; the next ones wait in arrival order, and other `Query` kinds are unaffected.
  - A queued query is replaced, and answered `Busy`, only by a newer one with the same chart key (selector set and budget). Three charts on one page each queue a query and all three get answers.
  - The queue holds at most `MAX_IN_FLIGHT` queries; one more is answered `Busy`.
- Host-wide (`history_query/limits.rs`, held by `HostServer`, never a static):
  - At most `HISTORY_MAX_CONCURRENT` run across sessions. The next is answered `Busy`.
  - An identical request within `HISTORY_CACHE_TTL` reads no rows (a counting reader).
  - Two `HostServer`s in one process (two tests in one binary) don't share limits or cache.
- Tick timing (`crates/statglass-remote/tests/history_tick.rs`, in the style of `statglass-engine/tests/perf_gates.rs`): an engine on a fake ticker, with lane j1's seed, keeps every tick on its deadline (no tick later than the same run with no query) while 30-day, 32-series queries run back to back on the blocking pool.

**Phone history data (lane k)**
- `useHostHistory(host, selection, range, width)`:
  - It issues one `hostHistory` query, keyed by host, series, range and budget through `@core/query-keys`. The budget is `clamp(floor(width / 2.5), 30, 200)`, and a heatmap passes its column count.
  - It uses `staleTime` and `gcTime` of 30 s.
  - The existing hooks (`useModuleHistory`, `useEvents`, the stat values) keep their names and return shapes, and read that one query.
- Memory (`apps/mobile/test/data/host-history.test.tsx`):
  - Unmounting a module page and advancing fake time by 30 s leaves no history entry in the query cache.
  - Remounting inside 30 s makes no new call.
  - Changing the range makes one new call.
- Errors:
  - `RemoteUnsupported` renders "Update StatGlass on <host> to see history" in the chart area while the live value still updates.
  - `RemoteBusy` stays in the loading state and retries after 1 s, at most 3 times. After the third `RemoteBusy` the chart shows its load error ("StatGlass on <host> is busy") with Retry, and Retry starts a new round of 3 (a fake-timer test walks all four answers).
  - An offline host shows no history and makes no call.
- Settings > Data:
  - It has one switch, "Live updates on cellular", with a footer saying the host screen updates every 5 s on cellular when it is off.
  - The switch's value reaches Rust as `DataPolicy.live_on_cellular`, which `apps/mobile/test/transport/native-core-bridge.test.tsx` asserts (this lane owns that test; lane a owns the bridge, which the scaffold already switched).
  - `syncOnCellular` is gone from `phone-settings.tsx`, and the stored value is dropped on load.
- Mock (`packages/core/src/mock/host-history.ts`): it answers `hostHistory` from the existing generator with the same budget rule, clamp flags, module-filtered events and stats. It is tested once, and the demo hosts' charts use it.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | apps/mobile/src/transport/core-provider.tsx, apps/mobile/src/transport/native-transport.ts, apps/mobile/src/transport/native-core-bridge.tsx, apps/mobile/src/transport/index.ts, apps/mobile/src/data/transport-context.tsx, apps/mobile/src/data/demo.ts, apps/mobile/src/app/_layout.tsx, apps/mobile/src/app/(hosts)/_layout.tsx, apps/mobile/src/app/(hosts)/index.tsx, apps/mobile/src/app/settings/_layout.tsx, apps/mobile/src/app/demo.tsx, apps/mobile/src/lib/query-client.ts, apps/mobile/src/module/index.tsx, apps/mobile/src/ui/navigation-theme.ts, apps/mobile/src/ui/theme-colors.ts, apps/mobile/src/debug/, apps/mobile/test/render.tsx, apps/mobile/test/transport/core-provider.test.tsx, apps/mobile/test/navigation/, apps/mobile/test/debug/, apps/mobile/test/app/ | contracts, audit-architecture F1, F4, I2, I7, M2, M3 (providers), M5; audit-errors M8, L4 | core owner, theme, error boundary, route guard, cache scope | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test`, `make mobile-check`, `make mobile-native-check`; simulator screenshots of the hosts list, host and module headers in light and dark, the module title legible in dark |
| b | M | biome.json, scripts/architecture/test_biome_rules.py, .claude/hooks/enforce-boundaries.sh, apps/mobile/src/lock/snapshot-cover.ts, apps/mobile/src/transport/device.ts, apps/mobile/modules/statglass-native/index.ts, apps/mobile/test/native/snapshot-cover.test.tsx, apps/mobile/test/transport/fake-native.ts, apps/mobile/test/helpers/, apps/mobile/jest.config.cjs, apps/mobile/tsconfig.json, scripts/mobile/check.sh, .claude/rules/mobile/expo.md, .claude/rules/rust/crates.md | contracts, audit-architecture I1, M15, M16, M18; audit-tests H1, L5, L7 | boundary rules with fixtures, FakeNative only | gpt-6.2-sol | pending | | `make architecture-test architecture-check agent-hooks-test`, `bun run lint`, `bun run --cwd apps/mobile test`, `make mobile-check` |
| c | L | packages/core/src/live-session.ts, packages/core/src/live-session.test.ts, src/app/stores/host-store.tsx, apps/mobile/src/data/live-subscription.ts, apps/mobile/src/data/live.ts, apps/mobile/test/data/live-session.test.tsx | contracts, audit-architecture F3; audit-errors L1, L5 | one live-session policy, both adapters | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/live-session.test.ts src/app/stores`, `bun run --cwd apps/mobile test -- test/data test/host`, `bun run typecheck`, `make e2e-perf` (before and after reported) |
| d | L | crates/statglass-ipc/src/vitals.rs, crates/statglass-ipc/src/error.rs, crates/statglass-ipc/src/error/remote.rs, crates/statglass-session/src/connect.rs, crates/statglass-session/src/connect/tests.rs, crates/statglass-session/src/source/status.rs, crates/statglass-session/src/source.rs, crates/statglass-session/src/source/quiesce.rs, crates/statglass-session/src/source/control.rs, crates/statglass-session/src/source/policy.rs, crates/statglass-session/src/source/phone_tests.rs, crates/statglass-session/src/mirror_policy.rs, crates/statglass-session/src/mirror/tests.rs, crates/statglass-session/src/lib.rs, crates/statglass-session/src/dialer.rs, crates/statglass-agent/src/restricted.rs, crates/statglass-ipc/tests/phase3_gate.rs | contracts, audit-errors H3 (Rust half), M3, M4, M7, L5, L7, L8; RFC 3.3; D-152 | incompatible side, panic status, refusals, phone-only mirror code removed, desktop mirror unchanged | gpt-6.2-sol | pending | | `cargo test -p statglass-session -p statglass-ipc -p statglass-remote -p statglass-agent`, `cargo test -p statglass remote`, `make rust-check`, `make architecture-check` |
| e | M | apps/mobile/modules/statglass-native/ios/, apps/mobile/modules/statglass-native/ios-tests/, apps/mobile/modules/statglass-native/src/, apps/mobile/src/transport/envelope.ts, apps/mobile/src/transport/build-info.ts, packages/core/src/command-error.ts, packages/core/src/native-errors.ts, packages/core/src/native-errors.test.ts, crates/statglass-mobile/src/signer.rs, crates/statglass-mobile/src/ffi.rs, apps/mobile/test/native/native-error.test.ts, apps/mobile/test/transport/envelope.test.ts | contracts, audit-errors M1, M2, L6; audit-architecture M11; audit-tests M9 | typed native errors, fallible key, Swift contract test | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/native-errors.test.ts`, `bun run --cwd apps/mobile test -- test/native test/transport`, `swift test --package-path apps/mobile/modules/statglass-native/ios-tests`, `cargo test -p statglass-mobile signer`, `make mobile-native-check` |
| f | L | packages/core/src/phone-connection.ts, packages/core/src/phone-connection.test.ts, packages/core/src/remote-errors.ts, packages/core/src/remote-errors.test.ts, packages/core/src/mock/phone-errors.ts, packages/core/src/mock/failures.ts, packages/core/src/mock/failures.test.ts, apps/mobile/src/connection/, apps/mobile/src/data/hosts.ts, apps/mobile/src/host/connection-pill.tsx, apps/mobile/src/host/host-page.tsx, apps/mobile/src/hosts/host-row.tsx, apps/mobile/src/hosts/hosts-list.tsx, apps/mobile/test/connection/, apps/mobile/test/hosts/hosts-list.test.tsx, apps/mobile/test/host/host-screen.test.tsx, apps/mobile/test/module/module-screen.test.tsx | contracts, RFC 3, audit-errors H3, M9, L2; audit-architecture I3; audit-tests H2, M3, M5, M6, M10 | one test per RFC 3 row, fixtures in the mock | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/phone-connection.test.ts packages/core/src/remote-errors.test.ts packages/core/src/mock`, `bun run --cwd apps/mobile test`, `make mobile-check`; simulator screenshots of each `phone-errors` host in light and dark |
| g | L | packages/core/src/popover/cards/, packages/core/src/widget-models/stat-list.ts, src/app/routes/popover/_components/popover-cards.tsx, apps/mobile/src/cards/, apps/mobile/src/host/card-stack.ts, apps/mobile/test/host/card-stack.test.tsx, apps/mobile/src/widgets/stat-list.tsx, apps/mobile/src/widgets/meter-track.tsx, apps/mobile/src/widgets/accent.tsx, apps/mobile/test/cards/ | contracts, audit-architecture F2, M6; audit-tests M1; `.claude/skills/widget-model/` | card models tested once, both renderers | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/popover src/app/routes/popover`, gallery and render-count e2e, `make e2e-perf` (before and after), `bun run --cwd apps/mobile test -- test/cards`, `make mobile-check`; desktop popover screenshots unchanged, phone host screen unchanged |
| h | L | crates/statglass-proto/tests/addresses_skew.rs, crates/statglass-remote/src/host_server.rs, crates/statglass-remote/src/addresses.rs, crates/statglass-agent/src/host.rs, src-tauri/src/addresses.rs, src-tauri/src/hosts.rs, crates/statglass-mobile/src/sessions/addresses.rs, packages/core/src/mock/addresses.ts | contracts, D-093, D-153, `plan/architecture.md` (one-way doors), RFC 3.3 | codec round trip and skew both ways, D-093 rules, Docker answer | gpt-6.2-sol | pending | | `cargo test -p statglass-proto -p statglass-remote -p statglass-session -p statglass-agent addresses`, `cargo test -p statglass addresses`, `make ssh-docker-test` (container answers), `make rust-check`, `make rust-linux-check` |
| i | L | crates/statglass-mobile/src/mobile_core.rs, crates/statglass-mobile/src/envelope.rs, crates/statglass-mobile/src/policy.rs, crates/statglass-mobile/src/control.rs, crates/statglass-mobile/src/lifecycle.rs, crates/statglass-mobile/src/sessions.rs, crates/statglass-mobile/src/sessions/host.rs, crates/statglass-mobile/src/sessions/registry.rs, crates/statglass-mobile/src/sessions/registry/, crates/statglass-mobile/src/sessions/commands.rs, crates/statglass-mobile/src/sessions/history.rs, crates/statglass-mobile/src/sessions/tests/, crates/statglass-mobile/tests/mobile_session.rs, scripts/ssh-docker/run.sh | contracts, D-152, audit-errors H2, H4 | no mirror directory, reshaped open errors, vitals age, history client and its errors, unknown events skipped, quiesce without writes, panic logged once, Docker facade test | gpt-6.2-sol | pending | | `cargo test -p statglass-mobile`, `make mobile-rust-check`, `make rust-check`, `make architecture-check` (the `statglass-store` edge kept), `make ssh-docker-test` passes `mobile_core_streams_and_reads_host_history` |
| j1 | L | crates/statglass-store/src/tier_budget.rs, crates/statglass-store/src/reader.rs, crates/statglass-store/src/reader/tiers.rs, crates/statglass-schema/src/event_module.rs, crates/statglass-remote/src/history_query.rs, crates/statglass-remote/src/history_query/read.rs, crates/statglass-remote/tests/history_query.rs, crates/statglass-remote/tests/support/history_seed.rs, crates/statglass-proto/tests/history_skew.rs | contracts, D-152, D-083, `.claude/rules/rust/testing.md`, `crates/statglass-store/src/db.rs` | codec and skew (future event kind, future clamp), bounds and clamps, heatmap clamp, tier choice, layout filter and rows read, recent rows, per-key stats, event filter | gpt-6.2-sol | pending | | `cargo test -p statglass-proto -p statglass-store -p statglass-schema -p statglass-remote history`, `cargo test -p statglass-store`, `make rust-check`, `make rust-linux-check`; the byte bound, clamp and recent-rows tests reverted-verified |
| j2 | M | crates/statglass-remote/src/answering.rs, crates/statglass-remote/src/history_query/limits.rs, crates/statglass-remote/tests/history_concurrency.rs, crates/statglass-remote/tests/history_tick.rs | contracts, D-152, D-117, `crates/statglass-engine/tests/perf_gates.rs`, `perf-budget.json`, lane j1's `tests/support/history_seed.rs` | per-session queue by chart key, host-wide semaphore and cache on `HostServer`, tick timing | gpt-6.2-sol | pending | | `cargo test -p statglass-remote answering history`, `cargo test -p statglass-agent`, `make rust-check`, `make rust-linux-check`; the queue, semaphore and tick-timing tests reverted-verified |
| k | M | apps/mobile/src/data/history.ts, apps/mobile/src/data/phone-settings.tsx, apps/mobile/src/app/settings/data.tsx, packages/core/src/mock/host-history.ts, packages/core/src/mock/host-history.test.ts, apps/mobile/test/data/host-history.test.tsx, apps/mobile/test/settings/data.test.tsx, apps/mobile/test/transport/native-core-bridge.test.tsx | contracts, D-152, `.claude/rules/mobile/testing.md` | budget from width, 30 s cache, release on unmount, unsupported, busy and busy-exhausted states, one cellular switch and its bridge test, mock answers | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/mock/host-history.test.ts`, `bun run --cwd apps/mobile test`, `make mobile-check`; simulator screenshots of a module page at 1 h and 7 d on a demo host |
| l | M | crates/statglass-mobile/Cargo.toml, Cargo.lock, crates/statglass-mobile/src/logging.rs, crates/statglass-mobile/src/facade_tests.rs | contracts, audit-errors H1; audit-tests M8; `crates/statglass-mobile/src/sessions/tests/mod.rs` (`PeerDialer`) | os_log subscriber, facade unit test over a scripted dialer | gpt-6.2-sol | pending | | `cargo test -p statglass-mobile facade_tests logging`, `make mobile-rust-check`; one simulator log line from a forced open failure |

Ownership:
- **Lanes a and f split the app shell from the status wording.** Lane a owns `module/index.tsx` only to remove its `GestureHandlerRootView` and header options. Lane f renders its status through `hostStatusSummary` by the props the page already passes, so f doesn't touch that file.
- **The live tests stay put.** Lane c owns no existing screen test. If a host-screen assertion must change, it reports it to lane f.
- **Lane d's session status is read, not edited.** Lane f reads `incompatible_side` and `open_error` from the scaffold's types.
- **The scaffold cuts the phone off the mirror code, so lanes d and i don't depend on each other.** It removes every phone call into `SyncPolicy`, `set_sync_policy`, `MirrorPolicy::phone` and `PHONE_MIRROR_*` (the files listed in the code facts), leaving stubs lane i fills. Lane d then deletes the code from `statglass-session` and owns `crates/statglass-ipc/tests/phase3_gate.rs`, and both lanes pass the workspace gate in either merge order.
- **Lanes j1 and j2 split the host query by concern.** j1 owns the read path (store, tier, stats, events, the seed helper); j2 owns concurrency (`answering.rs`'s per-session queue, the host-wide semaphore and cache in `history_query/limits.rs`, the tick-timing test). The scaffold adds the `HostServer` field that holds j2's limits, so lane h keeps `host_server.rs` and nothing is a static. j2's tick test uses j1's `seed_by_retention`; the scaffold declares it, and j2 rebases on j1 before its final run.
- **Lane i owns `envelope.rs` and its log test.** Lane l installs the subscriber and tests it in `logging.rs`; the "`panicked` logs once" test sits with the file, in lane i.
- **Lane k owns `test/transport/native-core-bridge.test.tsx`.** Lane a owns the bridge; the scaffold already switched it to `live_on_cellular`.
- **The scaffold owns the shared wire files.** `crates/statglass-proto/src/query.rs`, `handshake.rs`, `crates/statglass-remote/src/scope.rs`, `host_queries.rs`, `crates/statglass-remote/tests/restricted.rs`, `crates/statglass-session/src/source/queries.rs` and `crates/statglass-ipc/src/mobile.rs` change only in the scaffold, so lanes h, i, j1 and j2 never share them. D-152 and D-153 are already in `plan/decisions.md` (written with this plan, before any codec change).
- **Lane e takes the backup exclusion.** It owns `statglass-native/ios/`, so it deletes `StatglassNativeModule.swift`'s mirror `isExcludedFromBackup` block.
- **Lane k's history hooks keep their signatures.** `module/index.tsx` (lane a) and `events-list.tsx` keep compiling unchanged.
- **Lane h's agent file is limited.** It owns `crates/statglass-agent/src/host.rs` only for `ServedHost::network_addresses`.

#### Scaffold contracts (phase 7)

Inline before dispatch. It registers the new modules with stub bodies (`statglass_store::tier_budget`, `statglass_schema::event_module`, `statglass_remote::{history_query, history_query::read, history_query::limits, addresses}`), extends `tests/restricted.rs` for both new queries, and runs `make bindings`, `bun run typecheck`, `make mobile-check` and `make rust-check`.

It also does the cross-lane cuts, so no lane waits on another:
- **Rust, phone off the mirror.** In `crates/statglass-mobile/src/{control,lifecycle,policy,sessions}.rs`, `sessions/host.rs` (the `MirrorPolicy::phone` at line 88), `sessions/registry.rs`, `sessions/registry/tests.rs` and `sessions/tests/{history,live,mod,registry}.rs`, every use of `SyncPolicy`, `set_sync_policy`, `MirrorPolicy::phone` and `PHONE_MIRROR_*` goes: `HostSession` opens no mirror (`mirror: None`), `policy.rs` keeps a `live_allowed` stub returning `true`, and the mirror-only tests are deleted. Lane i fills the rest; lane d deletes the session-crate code.
- **Rust, dead calls.** `MobileCall::SetHostsRecentInterest` and its `commands.rs` arm go (lane i removes `Registry::set_recent_interest`).
- **Rust, facade test seam.** `Sessions::start` takes the dialer as a parameter (`MobileCore::start` passes `RusshDialer::new(signer)` as today). `#[cfg(test)] pub(crate) fn MobileCore::with_dialer(signer, events, dialer: Arc<dyn Dialer>)`, `#[cfg(test)] mod facade_tests;` in `lib.rs`, and `sessions/tests/mod.rs`'s `PeerDialer` and `Dial` made `pub(crate)`.
- **TypeScript, one switch from `queryHistory`/`queryEvents` to `hostHistory`.** Every phone caller, spy and fixture moves in the scaffold: `apps/mobile/src/data/history.ts` (a stub over `hostHistory` that lane k fills), `data/hosts.ts`, `data/seam.ts`, `transport/native-transport.ts`, `test/transport/transport.test.ts`, `test/hosts/hosts-list.test.tsx` and `test/module/module-screen.test.tsx`. `setHostsRecentInterest` leaves `data/seam.ts`, `native-transport.ts` and `transport.test.ts`. `syncOnCellular` becomes `liveOnCellular` in `debug/use-debug-core.ts`, `test/debug/debug-screen.test.tsx`, `transport/native-core-bridge.tsx`, `test/transport/native-core-bridge.test.tsx` and `test/transport/transport.test.ts` (lane k then removes it from `phone-settings.tsx` and `settings/data.tsx`). `mirror_budget_mb` leaves `transport/remote-hosts.ts`, `test/transport/native-fixtures.ts` and `test/transport/transport.test.ts`. The desktop `Transport`'s `queryHistory`/`queryEvents` and `packages/core`'s callers don't change.

```rust
// crates/statglass-session/src/source/status.rs (lane d fills it)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IncompatibleSide { Host, App }
// ConnectionStatus gains `pub incompatible_side: Option<IncompatibleSide>`
// RemoteError::IncompatiblePeer gains `side: Option<IncompatibleSide>`; constructors pass None
// statglass_ipc::status::RemoteConnection gains `pub incompatible_side: Option<IncompatibleSide>`
// ConnectionFailureKind gains `PhoneKeyUnavailable` (lane e produces it), `Internal` (lane d)

// crates/statglass-ipc/src/mobile.rs
// MobileRemoteHost gains `pub open_error: Option<CommandError>` and loses `mirror_budget_mb`
// DataPolicy becomes `{ pub live_on_cellular: bool }` (D-152); native-core-bridge.tsx pushes it
// MobileCall::QueryHistory and QueryEvents are replaced by:
MobileCall::HostHistory(HostHistoryRequest), // -> HostHistoryPage (specta mirrors of the proto types)
// HostVitals gains `#[specta(type = Option<JsSafeInt>)] pub as_of_ms: Option<i64>`
MobileCall::NetworkAddresses { host: HostId }, // -> HostAddressesInfo (specta mirror of HostAddresses)
// Phase 8 lane d's useProcessDemand calls this; phase 8 lane d implements it in sessions/processes.rs (stub: Ok(Null))
MobileCall::SetProcessInterest { host: HostId, interested: bool, view: Option<ProcessView>, stream: Option<u32> }, // -> null
// MobileCall::SetHostsRecentInterest is removed (dead on the phone)
// crates/statglass-ipc/src/live/contracts.rs: SubscriptionInfo gains
#[specta(type = JsSafeInt)] pub recent_ms: i64, // filled from statglass_ipc::live::RECENT_MS; lane c reads it, so both apps stop copying 120 s and 60 s
// crates/statglass-ipc/src/error.rs
CommandError::RemoteRefused { message: String },

// crates/statglass-proto/src/query.rs (lane h fills the codec and the answer)
Query::NetworkAddresses,
Answer::NetworkAddresses(HostAddresses),
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostAddresses {
    pub interface: Option<String>, pub link_mbps: Option<u32>,
    pub ipv4: Vec<Ipv4Addr>, pub ipv6: Vec<Ipv6Addr>,
    pub public_ip: PublicIp, pub as_of_ms: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum PublicIp { Known { ip: IpAddr }, Pending, Unavailable { reason: String }, Unknown }
// Unknown: a state from a newer host. Decoded through query.rs's Tagged/lenient (impl Tagged for PublicIp), never #[serde(other)]
// crates/statglass-remote/src/host_server.rs: ServedHost gains
fn network_addresses(&self) -> HostAddresses { HostAddresses::unavailable("not implemented") } // default
// crates/statglass-mobile/src/ffi.rs: NativeSigner::public_key -> Result<Vec<u8>, NativeSignerError> (lane e)
// crates/statglass-mobile/src/logging.rs: pub(crate) fn init() (lane l; stub no-op, called from MobileCore::new)

// crates/statglass-proto/src/query.rs (lane j1 fills the answer; D-152)
Query::History(HistoryQuery),
Answer::History(HistoryAnswer),
pub struct HistoryQuery {
    pub series: Vec<SeriesSelector>, pub from_ms: i64, pub to_ms: Option<i64>, // None: ending now
    pub max_points: u32, pub events_for: Option<Module>,
}
pub struct HistoryAnswer {
    pub tier: Tier, pub bucket_ms: i64, pub complete_to_ms: i64,
    pub series: Vec<WireHistorySeries>, // { key, points: Vec<(t, avg, min, max)>, hold_ms }
    pub gaps: Vec<Gap>,
    pub events: Vec<WireEvent>, // rows, so a newer kind passes; the client skips what it can't decode (D-083)
    pub stats: Vec<WireSeriesStats>, // { key: SeriesKey, avg, peak }: per series key, never pooled per metric
    pub clamped: Vec<HistoryClamp>,
}
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum HistoryClamp { Points, Series, Events, Bytes, Unknown } // Unknown through Tagged/lenient, like PublicIp
// crates/statglass-proto/src/handshake.rs
pub const HISTORY_QUERY_FEATURE: &str = "query.history.v1"; // in local_features()
pub const ADDRESSES_QUERY_FEATURE: &str = "query.addresses.v1";
// crates/statglass-remote/src/scope.rs: Restricted allows History and NetworkAddresses; restricted.rs asserts both and every other refusal
// crates/statglass-remote/src/host_queries.rs: Query::History => history_query::answer(..) (stub: Unsupported)
// crates/statglass-remote/src/history_query.rs (lane j1): the limits as named constants
pub const HISTORY_MAX_POINTS: u32 = 500; pub const HISTORY_MAX_SERIES: usize = 32;
pub const HISTORY_MAX_CORE_SERIES: usize = 256; // a request whose selectors are all one per-core metric (the CPU heatmap)
pub const HISTORY_MAX_EVENTS: usize = 200; pub const HISTORY_MAX_ANSWER_BYTES: usize = 512 * 1024;
// crates/statglass-remote/src/history_query/limits.rs (lane j2)
pub const HISTORY_MAX_CONCURRENT: usize = 2; pub const HISTORY_CACHE_TTL: Duration = Duration::from_secs(10);
pub struct HistoryLimits { /* semaphore, 16-entry cache */ } // stub: no limit, no cache
// crates/statglass-remote/src/host_server.rs: HostServer gains `history_limits: Arc<HistoryLimits>`, built in HostServer::new
// crates/statglass-store/src/tier_budget.rs (lane j1): pub fn tier_for_budget(from_ms: i64, to_ms: i64, max_points: u32, retained: TierCoverage) -> Tier
// crates/statglass-schema/src/event_module.rs (lane j1): impl EventDetail { pub fn module(&self, catalog: &Catalog) -> Option<Module> }
// crates/statglass-remote/tests/support/history_seed.rs (lane j1): pub fn seed_by_retention(dir: &Path, series: &[SeriesKey], now_ms: i64) -> Arc<HistoryStore> // stub: an empty store
// crates/statglass-session/src/source/queries.rs: history(q) and network_addresses(), checking the negotiated feature
```

```ts
// apps/mobile/src/transport/core-provider.tsx (lane a)
export function CoreProvider(props: { children: ReactNode }): JSX.Element;
export function useNativeCore(): { core: NativeTransport | null; error: NativeError | CommandError | null; retry(): void };
// packages/core/src/live-session.ts (lane c)
export interface LiveSessionDeps<S> { subscribe: Transport["subscribeLive"]; apply(state: S): void;
  clock: { now(): number; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  visible(): boolean; onVisible(listener: (visible: boolean) => void): () => void; status(): RemoteHostStatus | null }
export function createLiveSession<S>(host: HostId, request: LiveRequest, deps: LiveSessionDeps<S>): { stop(): void; retry(): void };
// packages/core/src/phone-connection.ts (lane f), re-exported from remote-errors.ts
export function phoneProblem(record: RemoteHostRecord, nowMs: number): PhoneProblem | null;
export function hostStatusSummary(status: RemoteHostStatus | null, opts: { nowMs: number }): { label: string; tone: Tone; stale: boolean };
// packages/core/src/native-errors.ts (lane e)
export interface NativeError { source: "native"; kind: "keychain" | "secureEnclave" | "camera" | "localNetwork"; osStatus: number | null; message: string }
export function isNativeError(e: unknown): e is NativeError;
export function nativeErrorText(e: NativeError): { title: string; recovery: string };
// packages/core/src/popover/cards/index.ts (lane g)
export interface CardContent { title: string; headline: string | null; segments: readonly StackSegment[];
  items: readonly StatItemModel[]; bars: readonly InlineBarModel[]; spoken: string }
export function cpuCard(sel: CpuSelection, src: CardSource): CardContent; /* memoryCard, gpuCard, powerCard, networkCard, batteryCard */
// packages/core/src/mock-transport.ts: failNext(method: keyof Transport, error: CommandError): void (lane f implements in mock/failures.ts)
// PhoneTransport adds "networkAddresses" and "hostHistory" and drops "queryHistory"/"queryEvents"; native-transport.ts adds the callCore lines; mock wires mock/addresses.ts and mock/host-history.ts (stubs)
// packages/core/src/query-keys.ts: hostHistory(host, series, fromMs, toMs | "now", budget) key
```

`PhoneProblem`, `PhoneProblemKind` and `PhoneAction` are as listed in `plan/rfc-ios-polish.md` section 4.0. The `phone-errors` scenario name is registered in `packages/core/src/mock/fixtures.ts`.

#### Lane a brief
- **Goal:** one owner for the native core and the app shell, so pairing and demand build on production paths, not the debug screen.
- **Interface:** `CoreProvider`, `useNativeCore`, `navigationTheme(scheme)`, `useThemeColors()`, `AppProviders`, the root `ErrorBoundary`.
- **Behavior:**
  - `CoreProvider` sits inside `PhoneTransportProvider` in the root layout. It starts the core from persisted config once, keeps it in a ref, disposes it on unmount, and selects the native transport when hosts exist.
  - The debug screen reads hooks only.
  - The transport barrel becomes the only import path for `@/transport` outside the folder.
  - The route guard lives in `(hosts)/_layout.tsx` and redirects to `/` when `useOptionalPhoneTransport()` is null.
- **Decisions already made:** no persisted host list in TypeScript (phase 8 keeps hosts in Rust); settings stay a nested stack until the polish phase decides presentation (architecture I6).
- **Out of scope:** pairing, the welcome layout, status wording (lane f).
- **Done when:** the table's Done-when conditions are met.

#### Lane b brief
- **Goal:** make the module boundaries and test rules mechanical.
- **Behavior:** as in Test cases.
  - Fixtures prove both a forbidden and an allowed import.
  - The `FakeNative` seam is exported as `__setNativeForTests` from `@native/statglass-native` under a `__DEV__`-only branch, so production bundles don't carry it. If Metro can't strip it, the seam stays as it is and the lane says why.
- **Out of scope:** moving other native calls (none exist).
- **Done when:** the table's Done-when conditions are met.

#### Lane c brief
- **Goal:** one live-subscription policy shared by both apps.
- **Behavior:**
  - Extract the desktop store's machine into `createLiveSession` with injected clock and visibility. The desktop adapter uses `document.visibilityState`; the phone adapter uses focus and `AppState`.
  - Constants live in one place, and the catch-up window comes from Rust.
  - Terminal state comes from the host status.
  - The desktop's behavior is the reference: its tests must pass unchanged.
- **Decisions already made:**
  - Both apps keep retrying with backoff, because Rust's status, not a client list, says when a host needs the user.
  - Data hooks stay per platform (RFC 4.6).
- **Out of scope:** focus-driven demand (phase 8), chart label hooks (polish).
- **Done when:** the table's Done-when conditions are met.

#### Lane d brief
- **Goal:** session failures reach the phone typed, and the session crate loses the phone-only mirror code.
- **Behavior:** as in Test cases.
  - The 1 Hz paths log through `RateLimit`.
  - Deleting `SyncPolicy` is a pure removal for the desktop: every desktop source ran `Full`.
- **Decisions already made:**
  - Vitals meaning stays in Rust (`as_of_ms`), so the phone never guesses staleness.
  - Incompatible direction is computed where the handshake ranges are known.
- **Out of scope:** TypeScript wording (lane f), native key errors (lane e), the phone facade (lanes i and l).
- **Done when:** the table's Done-when conditions are met.

#### Lane e brief
- **Goal:** native failures keep their kind from Swift to the screen, and a missing phone key is not reported as a host refusal.
- **Behavior:** as in Test cases.
  - The UniFFI trait change regenerates the Swift bindings through `make mobile-native-check`.
  - `PhoneKey.swift` maps OSStatus to the kinds.
- **Out of scope:** the screens that show these errors (lane f, phase 8 pairing).
- **Done when:** the table's Done-when conditions are met.

#### Lane f brief
- **Goal:** every RFC 3 state that Rust classifies renders its own phone sentence and action, and the phone has one status wording.
- **Behavior:**
  - The copy is the RFC 3 coverage table's.
  - `macMonitoringAdvice` is reused.
  - `remoteErrorAdvice` stays desktop-only.
  - The banner is a `connection/` component mounted by `host-page.tsx`.
  - Fixtures are typed with the generated types and live in core, so desktop tests can use them.
- **Decisions already made:**
  - Phone copy lives in core next to the desktop's, keyed by kind.
  - "Key not accepted by sshd" applies when the host was never seen. "No longer authorized" applies when it was seen.
- **Out of scope:** pairing failures (phase 8), visual polish (phase 10).
- **Done when:** the table's Done-when conditions are met.

#### Lane g brief
- **Goal:** each popover card's content is decided once in core.
- **Behavior:**
  - Follow the `widget-model` skill, one card per commit.
  - The models take selections and return text and segment models. The renderers keep layout.
  - Spoken text comes from the model.
- **Out of scope:** card visuals (phase 10), new cards.
- **Done when:** the table's Done-when conditions are met.

#### Lane h brief
- **Goal:** the host serves its own network addresses to its clients, including the restricted phone session.
- **Behavior:**
  - D-153 is written. The scaffold adds the types, the feature and the allowlist entry. `HostAddresses` is encoded as a CBOR map with optional fields, so later additions stay additive.
  - The resolver moves from `src-tauri/src/addresses.rs` into `statglass-remote::addresses`. That crate already spawns processes. The address readers come through `statglass_engine`'s re-export of the collect readers; add the re-export if it's absent, with no new crate edge.
  - `ServedHost::network_addresses` is implemented for the app (`src-tauri/src/hosts.rs`) and the agent (`crates/statglass-agent/src/host.rs`).
  - The resolver owns the public-IP cache: a known answer for 24 hours, a failure for 10 minutes, a fresh lookup early only when the local address, primary interface or egress interface changes. It looks up only when a client asks, never in the background, and answers `Pending` on a cold cache instead of waiting.
  - The desktop's own "This Mac" path keeps its current commands in this phase; phase 8 lane e moves every desktop surface onto the resolver's answer.
- **Decisions already made:**
  - The user's 2026-11-25 decisions: show the host's addresses on the phone (reversing the polish RFC's proposal), and every host, Linux agents included, looks up its own public IP with no switch (D-153).
  - Wire changes are additive only. `PublicIp` decodes a newer state as `Unknown` through `Tagged`/`lenient`.
  - On Linux, curl comes from `/usr/bin/curl` only, matching D-058's "system tools only".
- **Out of scope:** the phone Network page UI (phase 12), the desktop surfaces (phase 8 lane e).
- **Done when:** the table's Done-when conditions are met.

#### Lane i brief
- **Goal:** the phone's Rust core holds no history and reads it from the host.
- **Interface:** `MobileCall::HostHistory`, `policy::live_allowed`, `MobileRemoteHost.open_error`.
- **Behavior:** as in Test cases.
  - `HostSession` loses `mirror`, `with_history` and `close_history`.
  - `sessions/history.rs` converts between the proto answer and the IPC page, with no aggregation.
  - `statglass-store` stays a direct dependency for `phone_id.rs`. The lane states that in its report and leaves `crate-edges.json` unchanged.
  - The scaffold already removed the phone's calls into the mirror code and left stubs; the lane fills them.
- **Decisions already made:** D-152. No merge order with lane d (the scaffold cut the calls).
- **Out of scope:** demand and `PARK_GRACE` (phase 8 lane d), the host side (lanes j1 and j2), the subscriber (lane l).
- **Done when:** the table's Done-when conditions are met.

#### Lane j1 brief
- **Goal:** a host answers a phone's history question with a bounded, final answer that reaches now.
- **Behavior:** as in Test cases.
  - `history_query::answer` runs inside the existing `Answering` blocking task; the read lives in `history_query/read.rs`.
  - The read path:
    - build a `statglass_store::HistoryQuery` with `TierChoice::Fixed(tier_for_budget(..))` and the clamped `max_points`;
    - read with `HistoryStore::history_through_now(&query, recent)`, where `recent` returns `self.host.hub().recent_rows(host_id, from.max(now - RECENT_ROWS_MS), to.min(now))`, the same bounded call `HostServer::recent` makes (`host_server.rs:121-127`). Never pass the raw live ring;
    - take `complete_to_ms` from that snapshot;
    - compute stats per series key, calling `range_stats` on the read narrowed to each key (or a per-key variant in `reader/stats.rs` if the lane adds one to its files; say which);
    - read events with `r.events(..)` as `WireEvent` rows, filtered by `EventDetail::module`.
  - `reader.rs` adds `layout_id IN (...)` to the tier SQL, computed from the selectors, for every read.
  - The store's existing reader checkout is used. There is no second pool.
  - `seed_by_retention` writes through the store's own `Writer` and prunes as the app does, so the M15 and `tier_1m` union is real.
- **Decisions already made:** D-152 (the limits, the heatmap clamp, the tier rule, recent rows bounded as above), D-117 (the query path), D-083 (events as rows).
- **Out of scope:** the queue, semaphore, cache and tick test (lane j2), the client (lane i), the desktop's use of the query.
- **Done when:** the table's Done-when conditions are met. Report wall and CPU time per query at 1 h, 24 h, 7 d and 30 d from `history_query.rs` (they're also measured on the container in phase 8 lane d).

#### Lane j2 brief
- **Goal:** history queries can't stack up on a host or delay its sampler.
- **Behavior:** as in Test cases.
  - `answering.rs` gains a per-session history queue: one runs, the rest wait in order, and a newer query with the same chart key (selector set and budget) replaces the queued one, which is answered `Busy`. Other `Query` kinds keep today's path.
  - `history_query/limits.rs` holds the host-wide semaphore and the 16-entry cache, reached through the `HostServer.history_limits` field the scaffold added. No statics: two servers in one process share nothing.
  - `HISTORY_CACHE_TTL` keys on the selectors, the range rounded to the bucket width, and the budget. If lane j1's measurement shows a 30-day query under 5 ms of CPU, this lane may drop the cache and record why.
- **Decisions already made:** D-152 (the queue rule, the host-wide limit and the cache), D-117.
- **Out of scope:** what a query reads (lane j1).
- **Done when:** the table's Done-when conditions are met.

#### Lane k brief
- **Goal:** phone charts ask the host for exactly what they draw and forget it when they leave the screen.
- **Behavior:** as in Test cases.
  - Widths come from `onLayout`. The first render with no width doesn't query.
  - The hosts-list row series (`cpu.total`, `mem.used`, `net.rx_total`, `net.tx_total`, 30 minutes, budget from the column width) use the same hook. The row uses the totals, never the per-interface `net.rx`/`net.tx` (`catalog.rs:246-247` carry an `iface` label). Phase 8 lane d appends summaries to them.
  - The CPU heatmap's per-core series (`cpu.load{core=*}`) are their own query, separate from the page's other charts, with the heatmap's column count as the budget, so the host's 256-series per-core clamp applies to it.
- **Decisions already made:** D-152. A 30 s cache: back-and-forth taps don't refetch, and the live ring's 60 s backfill covers anything newer.
- **Out of scope:** chart visuals (phase 11), demand (phase 8).
- **Done when:** the table's Done-when conditions are met.

#### Lane l brief
- **Goal:** Rust failures on the phone leave a trace, and the facade has a hermetic test over a scripted dialer.
- **Behavior:** as in Test cases.
  - The facade test uses the scaffold's `MobileCore::with_dialer` and `PeerDialer`; it writes no SSH or protocol server. The real-SSH end-to-end test is lane i's Docker test.
  - The subscriber uses `tracing-oslog`, pinned exactly, added through this lane's Cargo.toml grant. If the crate is unavailable or pulls a non-system library (D-058), write a 30-line `Layer` over `os_log` through FFI and say so.
- **Out of scope:** what the facade does and `envelope.rs`'s log test (lane i).
- **Done when:** the table's Done-when conditions are met.

### Phase 8: pairing and live hosts in the app

Demo:
- **Linux host in Docker (the live check):** `scripts/ssh-docker/serve.sh` starts the repo's OpenSSH test container with the Linux `statglass-agent` and leaves it running, printing the published `127.0.0.1:<port>`. `docker exec -it <container> statglass-agent pair --target lan=127.0.0.1 --port <port>` prints the payload text, a Unicode QR and the code. In the simulator, "Add a host" > "Paste code" takes the payload text (the simulator has no camera), shows the host name and the code, and starts pairing. The terminal prompts `Approve <name> (<model>), code <ABC123>? [y/N]`; `y` lands the phone on the hosts list with the container's host Live, its CPU tracking a `stress`-style load started with `docker exec`. After a full app relaunch the host is still listed and goes Live again without pairing.
- **Mac side:** "Pair iPhone" is exercised by its existing `cargo test -p statglass pairing`, `src/app/routes/dashboard/settings/_components/paired-devices/pairing.test.tsx` and `tests/e2e/settings-pairing.spec.ts`, plus a browser screenshot of the sheet on `bun run dev:fast` with the mock transport. The run does not turn on Remote Login or edit `~/.ssh/authorized_keys`, so no live pairing against this Mac.
- **Camera:** "Scan QR" is built with `expo-camera` for devices; in the simulator it shows the camera-unavailable state and offers Paste. The camera path is unverified until a device run; Paste covers the simulator.
- **Local Network privacy:** the simulator doesn't enforce it, so the `local_network` error path (phase 7 lane e) and the `NSLocalNetworkUsageDescription` prompt are marked "unverified on device" in the Log, not done. The key itself is in `app.config.ts` (this phase's scaffold), because LAN pairing needs it on any device.
- **Facade end to end:** `make ssh-docker-test` runs phase 7 lane i's `mobile_core_streams_and_reads_host_history` again, after pairing and demand land.
- **Desktop addresses for remote hosts (lane e):** on `bun run dev:fast` with the mock, a remote demo host's Network page address line, Overview machine header and popover Network card show its interface, LAN address and public IP; a mock host built before `query.addresses.v1` shows no address row and no error.
- **Error states:** each pairing outcome renders its own message from `@core/remote-errors` through `SGPDEMO:<outcome>` payloads (dev builds and jest only); connection states were built in phase 7 lane f and are re-shot after pairing.
- **Data demand:** measured bytes per second per host from the Docker agent at Compact, Full and Full with process interest, plus bytes and agent CPU per history query at 1 h, 24 h, 7 d and 30 d and during 30 s of range flipping, recorded in the Log.

Depends on: phase 7

Code facts this phase relies on (checked 2026-11-25):

- `MobileCall` (`crates/statglass-ipc/src/mobile.rs:83-120`) has no pairing or host-removal call. `MobileCore::start` (`mobile_core.rs:55-68`) takes its hosts only from `MobileConfig`; nothing persists a host across launches. `MobileCore::call` (`mobile_core.rs:77-104`) dispatches core-level calls itself and the rest to `Sessions::call` (`sessions/commands.rs:31-60`, an exhaustive match that errors on core calls).
- `statglass_session::pairing::pair(dialer, payload, device_key, device_name, model, local)` is implemented (`crates/statglass-session/src/pairing.rs:24-80`); the dialer must carry the payload's pairing key. `statglass_proto::pairing::decode_payload(text, now_ms)` is implemented. `PairingPayload.pairing_key` is a P-256 scalar (`[u8; 32]`).
- `statglass-ssh`'s only in-memory signer, `SoftwareSigner`, is behind `#[cfg(any(test, feature = "software-signer"))]` (`signer.rs:136-180`) and has no constructor from a raw scalar. `RusshDialer::new(Arc<dyn Signer>)` is at `dialer.rs:61`.
- `statglass-mobile` may depend on schema, proto, store, engine, session, ipc and ssh, never remote (`scripts/architecture/crate-edges.json`).
- `CommandError::Pairing { reason: PairingFailure }` and `From<RemoteError> for CommandError` exist (`crates/statglass-ipc/src/error/remote.rs`). `PairingFailure` is `denied | expired | used | unknown | unavailable | invalid`.
- Handshake incompatibility knows its direction (`statglass-proto` `HandshakeError::Incompatible { local_min, local_max, peer_min, peer_max }`), but `connect.rs:263-267` flattens it into `RemoteError::IncompatiblePeer { version, reason }`, so no client can tell "update the host" from "update this app" (RFC 3.3).
- Agent pairing discovers targets from interfaces and assumes port 22 (`crates/statglass-agent/src/pair/bundle.rs:9-100`); the Docker fixture publishes sshd on `127.0.0.1:<random>` (`scripts/ssh-docker/run.sh:53-67`), so a bundle built inside the container is not dialable from the simulator without an override. `run.sh` removes the container on exit.
- The phone has two entry points, `pair.tsx` ("Pair with your Mac") and `pair-linux.tsx` ("Add a Linux server"), both "Not built yet" placeholders. The user collapsed them into one OS-neutral "Add a host" flow (Log 2026-11-25); `pair-linux.tsx` and its `Stack.Screen` are deleted in this phase. Both QR sources (the Mac app's "Pair iPhone" and `statglass-agent pair`) produce the same `PairingPayload`; `settings/device.tsx` reads "Available after pairing". `openDebugCore` (`apps/mobile/src/transport/native-transport.ts:131-152`) starts the one core per app run with no hosts, for the debug screen only.
- `phone-settings.tsx` is in memory ("persistence arrives with pairing").
- `@core/remote-errors` has `PAIRING_FAILURE_TEXT`, `macMonitoringAdvice` and desktop-worded `remoteErrorAdvice` ("SSH could not sign in… use the account signed in there"), which is wrong on a phone (RFC 2.5, 3.2).
- `expo-camera`, `expo-device` and `expo-file-system` are not installed.

Test cases:

**Facade pairing (Rust)**
- `preview_pairing(text)` decodes `SGP1:` text and returns `PairingPreview { host_id, name, os, user, targets, code, expires_ms }` without dialing. An expired payload returns `pairing{reason: expired}`; a bad checksum, wrong version, truncated base45 or a non-`SGP1:` string returns `pairing{reason: invalid}`.
- `pair` over a fake dialer: dials with an `EphemeralSigner` built from the payload's scalar (its public key equals the payload's), sends the phone's native-signer public key, device name and model, and on `Approved` adds the host (`MobileCommand::Restricted`, the approved targets, port, user and pinned keys) to the running sessions, persists it, emits `HostsChanged`, and returns `PairedHost { id, name }`.
- `Denied`, `Expired`, `Error{Used}`, `Error{Unknown}` and `Error{Unavailable}` map to `pairing{reason}` with that reason, and nothing is persisted. A host-key mismatch against the QR's fingerprints returns `host_key_unknown` and nothing is persisted. Pairing a payload whose host id is the phone's own id returns `remote_identity`.
- Pairing a host id that is already paired replaces its endpoint (re-pair) and keeps its name and card settings; the host list keeps one entry.
- `EphemeralSigner::from_scalar` rejects a zero or out-of-range scalar with `SignerError::Invalid`; a signature it makes verifies against `authorized_key_line` of its public key.
- Persistence: `<data_dir>/hosts.json` is written atomically (temp file in the same directory, then rename) with mode 0600; `start` with `MobileConfig { hosts: [] }` loads it and starts a session per stored host; a corrupt file is moved aside to `hosts.json.corrupt-<ms>`, logged, and the core starts with none (never fails startup); `set_hosts` and `remove_host` rewrite it; `remove_host` of an unknown id returns `unknown_host`.
- Docker (`crates/statglass-mobile/tests/docker_pair.rs`, `--ignored`, run by `make ssh-docker-test`): `MobileCore` with a software native signer pairs against `statglass-agent pair --ttl 60 --target lan=127.0.0.1 --port <p>` fed `y`, then streams a live frame from the restricted session; a second core built on the same data dir lists the host after `start`; a `n` run returns `pairing{reason: denied}` and leaves `hosts.json` unchanged.

- Restored phone: `hosts.json` records the phone's device public key; when `start` finds stored hosts and the native signer's key differs (an iCloud or device restore, since the Keychain key is `ThisDeviceOnly`), `PairingState` returns `{ hosts: n, key_changed: true }` and every stored host stays listed; a fresh install returns `{ hosts: 0, key_changed: false }`.

**Host side (Rust and Mac)**
- Pairing relay reasons: an unreachable control socket answers `PairError::NotRunning` (worded like the `APP_NOT_RUNNING`/`AGENT_NOT_RUNNING` markers), another device already waiting answers `Busy`, and relay failures log at `warn`; on the phone a deadline that fires mid-dial keeps the dial error instead of reporting `expired` (errors audit M6).
- Mac: `PairingStatus::Failed { reason: PairingFailure, message }` plus a `MonitoringOff` reason; the Pair iPhone views show `PAIRING_FAILURE_TEXT[reason]` with the message as detail (errors audit M5). `tests/e2e/settings-pairing.spec.ts` runs the flow once, takes dark screenshots in a screenshot-only loop, and expiry moves into `pairing.test.tsx` with fake timers (tests audit M11).
- Agent `pair --target lan=HOST` (repeatable, at most four, routes `lan` or `tailscale`) and `--port N` (1 to 65535) replace interface discovery and port 22 in the bundle; `--target` with an unknown route or no `=` exits 2 with usage; host keys still come from `/etc/ssh`.
- `scripts/ssh-docker/serve.sh` starts the fixture like `run.sh` without running tests, prints host, port, container name and the agent path, and leaves the container running until `serve.sh --stop <name>`; `scripts/ssh-docker/test_run.py` covers argument handling for both scripts.
- Container seed: `bun run seed` is the store's `seed` example with a macOS default directory. It already takes `--dir <data dir>` and seeds by retention (10 s buckets for the last day, minutes for the range, pruning rolling minutes older than 7 days into 15-minute buckets). `serve.sh --seed` builds the example for Linux in the same builder step that builds the agent (`cargo build -p statglass-store --example seed`), stops the agent, runs `seed --dir <agent data dir> --days 30` as the `statglass` user (it needs the `history.sqlite` the agent wrote on its first run), and starts the agent again. A test in `test_run.py` covers the argument; the seeded row counts are printed.

**Phone pairing (TS)**
- One primary action, "Add a host", opens one pairing screen with "Scan QR" and "Paste code" and help text naming both sources in plain words (the StatGlass app's "Pair iPhone" on a Mac; `sudo statglass-agent pair` in a terminal on any host). Paste accepts text with surrounding whitespace, rejects an empty field, and shows the preview (host name, OS glyph, user, routes, the six-character code, a countdown to `expires_ms`) before any dialing. No code path in `apps/mobile/src/pairing/` reads the host's OS to decide behavior (a test greps the module for `os ===`/`"macos"` branches); the OS only picks the glyph.
- Handover capability: a payload with `can_hand_over: true` (the Mac app's offers) shows "This host can also add the hosts it monitors" on the preview; the agent's payloads carry `false`. After approval the phone offers "Also add the N hosts this Mac monitors" only when the capability is set and the reply lists hosts (phase 8 builds that screen; phase 7 routes through `after-pair.ts`, which goes straight to `/(hosts)` until then).
- Scan: camera permission is requested on first use; granted shows the scanner and a decoded `SGP1:` QR goes to the preview; denied shows the camera-denied message with "Open Settings" and "Paste code"; no camera (simulator) shows the unavailable message with "Paste code".
- Confirm shows "Waiting for approval on <host>" with the code to compare and Cancel; Cancel abandons the wait locally (the host's offer expires on its own).
- Approved: the native transport is chosen (`setTransport(native, false)`), the query cache for hosts is invalidated, and the app replaces to `/(hosts)` with the new host listed. Each pairing failure (`denied`, `expired`, `used`, `unknown`, `unavailable`, `invalid`, `host_key_unknown`, `remote_unreachable`, `remote_auth`) shows its `@core/remote-errors` title and recovery with "Try again" (back to scan or paste) and "Done".
- Launch: with stored hosts, the first-launch screen starts the native core, chooses the native transport and replaces to `/(hosts)` before showing the welcome actions; with none it shows the welcome screen; a core start failure shows its native or command error text with Retry. The debug screen reuses the same core.
- Phone settings persist to `phone-settings.json` (document directory): a change is written within one debounce (500 ms), a relaunch restores it, a corrupt file falls back to defaults and is logged once. Settings > Hosts > Remove calls `removeHost` on the native transport, then drops the host from the phone settings. Settings > This iPhone shows the phone's public key line (`authorizedKeyLine("statglass-mobile")`) with a Copy button. Settings > Hosts has an "Update from Mac" row that opens `/update-from-mac` (a placeholder until phase 8).
- Mock pairing (`createMockPhonePairing`): `SGPDEMO:approve` approves after one tick, `SGPDEMO:<reason>` fails with that reason, anything else decodes like the real one (invalid). The pairing screen only accepts `SGPDEMO:` in `__DEV__`.

**Screen-scoped data demand (lane d)**
- Demand rules, one table in `apps/mobile/src/data/demand.ts`: hosts list focused: `compact` for each host whose row is visible (`onViewableItemsChanged`), nothing for rows off screen; host screen focused: `full` for the pager's current host only; module page focused: `full` for its host; Settings, pairing, welcome, demo chooser and debug: nothing. The app sends the union as one `SetDemand` call whenever it changes (coalesced to one call per frame).
- jest (real providers, mock transport recording `setDemand`): focusing a host screen sends exactly `[{ host, level: "full" }]`; swiping the pager to the next host sends the next host only; pushing Settings from a host screen sends `[]`; returning sends the host again; scrolling the hosts list changes the `compact` set to the visible rows.
- Rust (`crates/statglass-mobile/tests/demand.rs`, paused tokio time, fake dialer):
  - A host dropped from demand stays connected for `PARK_GRACE` (15 s) and is then parked: quiesced and its session closed. A host re-demanded inside the grace is never closed. `SetDemand([])` followed by `PARK_GRACE` leaves zero open sessions, and the core holds no per-host live ring, stream or history buffer for a parked host (`tests/demand.rs` inspects `Sessions`; D-152).
  - `compact` sends `Interest { detail: false }` and never `Subscribe { Live1s }`. The host then sends a `HostSummary` every 5 s, and nothing per tick. There is no history sync (D-152).
  - The row's 30-minute sparkline comes from one `Query::History` for its four series (`cpu.total`, `mem.used`, `net.rx_total`, `net.tx_total`; the totals, not the per-interface `net.rx`/`net.tx`) at the row's point budget, through phase 7 lane k's hook. It doesn't use `RecentRequest`, which carries only `from_ms`/`to_ms` and so returns every series' recent rows. A host without `query.history.v1` draws its sparkline from summaries as they arrive.
  - Each `HostSummary` appends one point to the row's sparkline series. The row's values and sparkline update every 5 s, and the status still reads Live.
  - `full` sends `Subscribe { Live1s }` (detail on, every engine frame). When `policy::live_allowed` is false (an expensive or constrained path with "Live updates on cellular" off), `full` runs as `compact`, and the status carries `demand: compact` so the pill can say so.
  - Process interest (`RemoteInterest.process_period_ms`, `network_processes`, `gpu_processes`) is set only while a module page's live process table is on screen, and cleared on blur. A host screen with no table sends none. `MobileCall::SetProcessInterest` (stubbed in the phase 7 scaffold) is implemented in `sessions/processes.rs`: it sets the session's interest, and the interest ends with the stream named by `stream` (a test closes the stream and sees the interest cleared).
- Measured (`crates/statglass-mobile/tests/docker_demand.rs`, `--ignored`, in `make ssh-docker-test`): a counting dialer wraps the russh channel and records bytes received per host from the Docker agent over 60 s at `compact`, `full` and `full` plus CPU process interest. The test prints the three rates and asserts only their order (`compact` < `full` < `full` + processes). The numbers go into the Log.
- Measured, history (same test file, same container, the agent's store seeded with 30 days by `scripts/ssh-docker/serve.sh --seed`, lane b):
  - Bytes received for one `Query::History` of a module page's series at a 200-point budget: 1 h, 24 h, 7 d and 30 d.
  - Agent CPU time and wall time per query for the same four ranges, read from `/proc/<agent pid>/stat` before and after each query.
  - Agent CPU while the client flips between 1 h, 24 h, 7 d and 30 d every 500 ms for 30 s.
  - All recorded in the Log. If any number is out of line with the engine's budgets in `perf-budget.json`, add a gate entry there. Raising an existing threshold needs a D-entry (`.claude/rules/verification.md`).
- Backgrounding: `quiesce` parks every source as today; a source added by `set_hosts` or `Pair` while backgrounded starts parked and dials nothing until `resume` (the Log's 4/a follow-up), and `resume` resumes only demanded sources.
- `apps/mobile/test/config/background-modes.test.ts` loads `app.config.ts` and asserts no `UIBackgroundModes` and no `BGTaskSchedulerPermittedIdentifiers` in `ios.infoPlist`, and no plugin that adds them (checked against the prebuilt `Info.plist` too when `apps/mobile/ios` exists).

**Desktop addresses for every host (lane e)**
- `get_host_addresses(host)` returns `HostAddressesInfo` for any host. For a remote host it calls the session's `network_addresses()` (`statglass-session` `source/queries.rs`, which owns the client query calls; the phase 7 scaffold added it). For this Mac it answers the same shape from the shared `statglass_remote::addresses` resolver, the one this Mac's host server uses for phones. `get_network_addresses` and `get_public_ip` are removed, so the desktop has one path and one public-IP cache rule (24 h, early on a network change, 10 min after a failure), held on the host.
- A remote host without `query.addresses.v1` returns `CommandError::RemoteUnsupported`; `useAddresses` maps it to no address row, with no error and no retry.
- `useAddresses` has no local-only gate. It asks while a surface that shows addresses is visible, re-reads the local part every 10 s as today, and while `public_ip` is `pending` polls every 2 s, at most 5 times.
- Vitest: the Network page's `address-line.tsx`, the Overview `machine-live-specs.tsx` header and the popover Network card in `popover-cards.tsx` each render a remote mock host's addresses; an old mock host renders no address row; `pending` turns into the IP after one poll under fake timers.
- The mock answers `getHostAddresses` for every demo host, local and remote, and `unsupported` for one old host.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-mobile/src/pairing.rs, crates/statglass-mobile/src/pairing/, crates/statglass-mobile/src/host_store.rs, crates/statglass-mobile/src/host_store/, crates/statglass-mobile/src/sessions.rs, crates/statglass-mobile/src/sessions/registry.rs, crates/statglass-mobile/src/sessions/tests/registry.rs, crates/statglass-mobile/tests/pairing.rs, crates/statglass-ssh/src/signer/ephemeral.rs | contracts, RFC 2.4, 3.4, `crates/statglass-session/src/pairing.rs` | facade pairing, persistence, ephemeral signer | gpt-6.2-sol | pending | | `cargo test -p statglass-mobile -p statglass-ssh`, `make mobile-rust-check`, clippy clean |
| b | L | crates/statglass-agent/src/pair.rs, crates/statglass-agent/src/pair/, crates/statglass-agent/src/cli.rs, crates/statglass-agent/tests/pair.rs, crates/statglass-remote/src/pairing/relay.rs, crates/statglass-session/src/pairing.rs, crates/statglass-mobile/tests/docker_pair.rs, scripts/ssh-docker/serve.sh, scripts/ssh-docker/run.sh, scripts/ssh-docker/test_run.py, src-tauri/src/pairing/status.rs, src/app/routes/dashboard/settings/_components/paired-devices/, tests/e2e/settings-pairing.spec.ts | contracts, `scripts/ssh-docker/`, audit-errors M5, M6, audit-tests M11 | agent target override, relay reasons, Mac pairing reasons, Docker serve, container seed and mobile pairing | gpt-6.2-sol | pending | | `serve.sh --seed` prints seeded S10, M1 and M15 row counts for the agent's store, `cargo test -p statglass-session -p statglass-agent -p statglass-remote pairing`, `cargo test -p statglass pairing`, `bun run test -- src/app/routes/dashboard/settings`, `tests/e2e/settings-pairing.spec.ts`, `python3 -B -m unittest discover -s scripts/ssh-docker -p 'test_*.py'`; `make ssh-docker-test` passes `docker_pair` (mobile) once lane a is merged |
| c | L | apps/mobile/src/app/pair.tsx, apps/mobile/src/app/pair-linux.tsx, apps/mobile/src/app/_layout.tsx, apps/mobile/src/app/index.tsx, apps/mobile/src/app/settings/data.tsx, apps/mobile/src/app/settings/appearance.tsx, apps/mobile/src/app/update-from-mac.tsx, apps/mobile/src/app/settings/device.tsx, apps/mobile/src/pairing/, apps/mobile/src/transport/native-transport.ts, apps/mobile/src/data/phone-settings.tsx, apps/mobile/src/data/pairing-context.tsx, apps/mobile/src/hosts/host-settings.tsx, apps/mobile/src/hosts/first-launch-redirect.tsx, packages/core/src/remote-errors.ts, packages/core/src/remote-errors.test.ts, packages/core/src/mock/phone-pairing.ts, packages/core/src/mock/phone-pairing.test.ts, apps/mobile/test/pairing/, apps/mobile/test/transport/pairing.test.ts, apps/mobile/test/settings/persistence.test.tsx, apps/mobile/test/first-launch.test.tsx, plan/decisions.md, plan/rfc-ios-app.md | contracts, RFC 1.4, 2.4, `.claude/rules/mobile/` | phone pairing, launch, persistence | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/pairing test/transport test/settings test/first-launch.test.tsx`, `bun run test -- packages/core/src/remote-errors.test.ts packages/core/src/mock/phone-pairing.test.ts`, `make mobile-check`, `make mobile-native-check`; simulator pairing against the Docker host (Demo) with screenshots |
| d | L | apps/mobile/src/data/demand.ts, apps/mobile/src/data/live.ts, apps/mobile/src/data/hosts.ts, apps/mobile/src/data/history.ts, apps/mobile/src/hosts/hosts-list.tsx, apps/mobile/src/data/processes.ts, apps/mobile/src/host/index.tsx, crates/statglass-mobile/src/sessions/demand.rs, crates/statglass-mobile/src/sessions/processes.rs, crates/statglass-mobile/src/lifecycle.rs, crates/statglass-mobile/tests/demand.rs, crates/statglass-mobile/tests/docker_demand.rs, apps/mobile/test/demand/, apps/mobile/test/config/background-modes.test.ts | contracts, RFC 3.1, `apps/mobile/modules/statglass-native/ios/AppLifecycle.swift` | screen-scoped demand, park grace, backgrounded sources, no background modes | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/demand test/config test/data`, `cargo test -p statglass-mobile demand lifecycle`, `make mobile-rust-check`, `make mobile-check`; on the Docker host in the simulator, the debug screen's session list shows the session closing 15 s after opening Settings and reopening on return; `docker_demand` run, with its three byte rates, the history bytes and agent CPU per query at 1 h, 24 h, 7 d and 30 d, and the agent CPU during 30 s of range flipping recorded in the Log |
| e | M | src-tauri/src/host_addresses.rs, src/app/hooks/use-addresses.ts, src/app/hooks/use-addresses.test.tsx, src/app/routes/dashboard/network/_components/address-line.tsx, src/app/routes/dashboard/network/_components/address-line.test.tsx, src/app/routes/dashboard/overview/_components/machine-live-specs.tsx, src/app/routes/dashboard/overview/_components/machine-live-specs.test.tsx, src/app/routes/popover/_components/popover-cards.tsx, src/app/routes/popover/_components/popover-cards.test.tsx, packages/core/src/mock/addresses.ts, packages/core/src/mock/usage-queries.ts | contracts, D-093, D-153, `plan/design-system.md`, `crates/statglass-remote/src/addresses.rs` | one command for every host, old host shows no row, pending poll, three surfaces on a remote host | gpt-6.2-sol | pending | | `cargo test -p statglass host_addresses`, `bun run test -- src/app/hooks src/app/routes/dashboard/network src/app/routes/dashboard/overview src/app/routes/popover packages/core/src/mock`, `bun run typecheck`, `make e2e-perf` (before and after); browser screenshots on `bun run dev:fast` of the three surfaces for the local host, a remote demo host and the old host, compared with today's local screenshots, every difference named |

Ownership: no phase 8 file is owned by a running lane of another phase. Lane e takes the desktop address surfaces after phase 7: `popover-cards.tsx` was phase 7 lane g's and `mock/addresses.ts` lane h's, both merged before phase 8 starts, so the address work is a lane here rather than part of lane h. Lane d owns the data hooks (`data/live.ts`, `hosts.ts`, `history.ts`) so demand is declared in one place, the data layer, not per screen; later phases that edit those hooks keep the `useFocusDemand` calls. Lane a owns `sessions/registry.rs`; the scaffold adds the one call it makes into lane d's code (`demand::admit(&source, &lifecycle)` when a source is added). Lane c writes the pairing views under `apps/mobile/src/pairing/screens/` and the flow logic beside them (`flow.ts`, `after-pair.ts`), because phase 9 takes `after-pair.ts` and the polish phases take `screens/`.

#### Scaffold contracts (phase 8)

The scaffold runs `make bindings`, `bun install` and `bunx expo install expo-camera expo-device expo-file-system` in `apps/mobile`, then the typecheck, and fixes each file the type changes flag.

**Rust**

```rust
// crates/statglass-ipc/src/mobile.rs: three new MobileCall variants and two results
MobileCall::PreviewPairing { text: String },                                  // -> PairingPreview
MobileCall::Pair { text: String, device_name: String, model: String },       // -> PairedHost
MobileCall::RemoveHost { host: HostId },                                      // -> null
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct PairingPreview {
    pub host_id: HostId, pub name: String, pub os: String, pub user: String,
    pub targets: Vec<MobileTarget>, pub code: String,
    #[specta(type = statglass_schema::JsSafeInt)] pub expires_ms: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct PairedHost { pub id: HostId, pub name: String }
// PairingPreview also has `pub can_hand_over: bool`, from the payload capability below.
MobileCall::PairingState,                                                     // -> PairingState
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct PairingState { pub hosts: u32, pub key_changed: bool }            // key_changed: restored phone, re-pair needed
MobileCall::SetDemand { demand: Vec<HostDemand> },                            // -> null
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, specta::Type)]
pub struct HostDemand { pub host: HostId, pub level: DemandLevel }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DemandLevel { Compact, Full } // compact: HostSummary every 5 s; full: Live1s (D-152: no sync at either)

// crates/statglass-proto/src/pairing.rs: the handover capability (never an OS check)
// PairingPayload gains `#[serde(default)] pub can_hand_over: bool`, encoded last, with the
// round-trip and skew test (an old payload decodes as false; a new one decodes on old code).
// src-tauri/src/pairing/bundle.rs sets it true; statglass-agent leaves it false.

// crates/statglass-mobile/src/sessions/demand.rs (lane d)
/// How long a host stays connected after no screen demands it. Long enough that swiping
/// across the pager and back, or a quick look at Settings, keeps the SSH session (a fresh
/// dial and handshake costs 1-3 s on LAN, more on Tailscale); short enough that nothing
/// keeps pulling once the user has moved on.
pub(crate) const PARK_GRACE: Duration = Duration::from_secs(15);
pub(crate) fn set_demand(sessions: &Sessions, demand: Vec<HostDemand>) -> Result<Value, CommandError>; // stub: Ok(Null)
pub(crate) fn admit(source: &RemoteSource, lifecycle: &Lifecycle);                                    // stub: no-op

// crates/statglass-ssh/src/signer/ephemeral.rs (declared from signer.rs, re-exported; not behind a feature)
/// The one-time pairing key from a QR: a P-256 scalar held in memory for one pairing.
pub struct EphemeralSigner { /* SigningKey, Sec1Point */ }
impl EphemeralSigner { pub fn from_scalar(scalar: &[u8; 32]) -> Result<Self, SignerError>; } // stub: Err(Invalid("not implemented"))
impl Signer for EphemeralSigner { /* stub */ }

// crates/statglass-mobile/src/pairing.rs (declared in lib.rs; mobile_core.rs dispatches the two calls here)
pub(crate) fn preview(text: &str, now_ms: i64) -> Result<PairingPreview, CommandError>;            // stub: Err(Internal)
pub(crate) async fn pair(sessions: &Sessions, device_key: Vec<u8>, text: String,
    device_name: String, model: String) -> Result<PairedHost, CommandError>;                      // stub: Err(Internal)
// crates/statglass-mobile/src/host_store.rs
pub(crate) struct HostStore { path: PathBuf }
impl HostStore {
    pub(crate) fn new(data_dir: &Path) -> Self;                                 // <data_dir>/hosts.json
    pub(crate) fn load(&self) -> Vec<MobileHost>;                               // stub: vec![]; logs and quarantines a bad file
    pub(crate) fn save(&self, hosts: &[MobileHost]) -> Result<(), CommandError>; // stub: Ok(())
}
// Sessions::remove_host(&self, host: HostId) -> Result<(), CommandError> // stub: Err(UnknownHost)

// crates/statglass-agent/src/cli.rs
DeviceCommand::Pair { ttl_s: u64, targets: Vec<BundleTarget>, port: Option<u16> } // empty targets: discover
```

`sessions/commands.rs` gets `RemoveHost` routed to `Sessions::remove_host` and the two pairing calls listed with the other core-level calls. `mobile_core.rs` routes `PreviewPairing` and `Pair` to `pairing.rs` (Pair needs the native signer's public key, read through `NativeSignerAdapter`). No new crate edges.

**TypeScript**

```ts
// apps/mobile/src/data/pairing-seam.ts (scaffold-owned)
export interface PhonePairing {
  previewPairing(text: string): Promise<CommandResult<PairingPreview>>;
  pair(text: string, deviceName: string, model: string): Promise<CommandResult<PairedHost>>;
}
// apps/mobile/src/data/pairing-context.tsx (lane c): native when the module exists, else the mock
export function PairingProvider(props: { children: ReactNode; pairing?: PhonePairing }): JSX.Element;
export function usePhonePairing(): PhonePairing;
// apps/mobile/src/transport/native-transport.ts (lane c; the core itself comes from phase 7's useNativeCore): NativeTransport gains
removeHost(host: HostId): Promise<CommandResult<null>>;
export function nativePairing(core: NativeTransport): PhonePairing;
// packages/core/src/mock/phone-pairing.ts (lane c)
export function createMockPhonePairing(options?: { now?: () => number }): PhonePairing & { tick(): void };
```

```ts
// apps/mobile/src/data/demand.ts (lane d)
export type DemandLevel = "compact" | "full";
/** Declares demand for `host` while the calling screen is focused (useFocusEffect); the union goes to the core. */
export function useFocusDemand(host: HostId | null, level: DemandLevel): void;
export function useVisibleHosts(): { onViewableItemsChanged(info: { viewableItems: { key: string }[] }): void };
```

`PhoneTransport` gains `setDemand` and `pairingState`; `native-transport.ts` gets the `callCore` lines; the mock records demand (`mock.demand()` for tests).

Also: `PairingProvider` wraps the root stack in `apps/mobile/src/app/_layout.tsx` (scaffold edit); `PairError` gains `NotRunning` and `Busy` and `PairingStatus::Failed` gains `reason` (lane b fills both); `app.config.ts` gains `ios.infoPlist.NSLocalNetworkUsageDescription` ("StatGlass connects to your hosts on this network over SSH.", architecture audit I8) and the `expo-camera` plugin with `cameraPermission: "StatGlass uses the camera to scan the pairing code shown on your Mac or server."`; `settings/hosts.tsx` stays as is.

Desktop addresses (lane e): the scaffold declares `#[tauri::command] get_host_addresses(state, host: HostId) -> Result<HostAddressesInfo, CommandError>` in `src-tauri/src/host_addresses.rs` (stub: `Err(RemoteUnsupported)`) and registers it in `src-tauri/src/lib.rs`'s `collect_commands!`; removes `get_network_addresses` and `get_public_ip` from `src-tauri/src/commands.rs` and `lib.rs`; replaces `Transport.getNetworkAddresses`/`getPublicIp` with `getHostAddresses(host)` in `packages/core/src/transport/contracts.ts` and `src/desktop-transport/native-history.ts`; replaces `hostKeys.networkAddresses` and `appKeys.publicIp`/`publicIpAll` with `hostKeys.addresses(host)` in `packages/core/src/query-keys.ts` (and its test, `src/app/lib/query.tsx`, `query.test.ts`); and runs `make bindings`. `useAddresses` keeps its return shape over a stub, so the three surfaces keep compiling.

#### Lane a brief

- **Goal:** the Rust core can preview and complete a pairing from QR or pasted text, keeps paired hosts across launches, and can remove one.
- **Interface:** the scaffold signatures in `crates/statglass-mobile/src/{pairing,host_store}.rs`, `Sessions::remove_host`, `EphemeralSigner`.
- **Behavior:**
  - `preview`: `decode_payload(text.trim(), now_ms)`; map `PairError` to `CommandError::Pairing { reason }` (expired payloads say `expired`, every decode failure `invalid`). Targets keep the payload order.
  - `pair`: decode; refuse the phone's own id (`phone_id.rs`); build `RusshDialer::new(Arc::new(EphemeralSigner::from_scalar(&payload.pairing_key)?))`; call `statglass_session::pairing::pair(&dialer, &payload, &device_key, &name, &model, phone_id)`; turn the returned `Endpoint` into a `MobileHost { command: Restricted, .. }`; add or replace it in the running sessions (replace keeps the host's name and card settings), then `HostStore::save` of the whole list, then emit `HostsChanged`. A save failure after the session was added removes it again and returns the error, so the list on screen and on disk agree.
  - Errors map through `From<RemoteError> for CommandError`; the pairing key is dropped when `pair` returns.
  - `HostStore`: JSON array of `MobileHost`, atomic write (tempfile in the same directory, `fsync`, rename) at 0600; `load` never fails startup: a parse error renames the file to `hosts.json.corrupt-<ms>` and logs once.
  - `start`: hosts are `config.hosts` (the debug screen) followed by stored hosts not already in it; `set_hosts` and `remove_host` save.
  - The file is `{ "device_key": <base64 SEC1>, "hosts": [...] }`; `PairingState` compares `device_key` with the native signer's current key (restore detection). Re-pairing any host rewrites `device_key`.
  - Runs off the caller's thread on the core runtime like the other calls; never blocks Swift.
- **Decisions already made:** the phone's paired hosts live in Rust (`hosts.json` in the core's data directory), not in JS storage, so the core can start sessions before the UI asks; re-pairing an id replaces it; no new crate edge (the ephemeral signer lives in `statglass-ssh`, production code, because the pairing key is a bearer secret for minutes and P-256 like every other key, D-151).
- **Out of scope:** the host side, the agent CLI, Swift, the TypeScript screens, handover of other hosts (phase 9).
- **Done when:** the table's Done-when conditions are met.

#### Lane b brief

- **Goal:** the Docker host can be paired from the simulator, and both pairing hosts (relay and Mac) report why a pairing failed by reason, not text.
- **Behavior:**
  - Agent `pair`: parse `--target ROUTE=HOST` (repeatable, at most four) and `--port N`; when given, they replace `bundle_targets` and the default port in `pair/bundle.rs`; usage text lists both.
  - Relay: `NotRunning` and `Busy` reasons, `warn` logs; `session/src/pairing.rs` keeps the dial error when the deadline fires mid-dial.
  - Mac: `PairingStatus::Failed { reason, message }` and the views read `remoteErrorText` (which uses `PAIRING_FAILURE_TEXT[reason]`); the e2e spec runs once.
  - `serve.sh`: shares setup with `run.sh` (factor the container start into a function both call), prints `host`, `port`, `container`, `agent`, and keeps the container until `serve.sh --stop <container>`. `run.sh` behavior is unchanged.
  - `crates/statglass-mobile/tests/docker_pair.rs`: the approve and deny paths from the Test cases, through `MobileCore` with a software native signer, added to `run.sh`'s `--ignored` list.
- **Out of scope:** the facade (lane a), phone copy (lane c).
- **Done when:** the table's Done-when conditions are met.

#### Lane c brief

- **Goal:** pairing from the phone (scan or paste), the native transport chosen at launch for paired hosts, persisted phone settings, host removal, and the This iPhone key.
- **Interface:** `PhonePairing`, `PairingProvider`/`usePhonePairing`, `nativePairing`, `createMockPhonePairing`; the core from phase 7's `useNativeCore`.
- **Behavior:**
  - Routes: `pair.tsx` renders `PairScreen` from `@/pairing`; `pair-linux.tsx` is deleted with its `Stack.Screen` in `_layout.tsx` (the only edit to that file), and the welcome screen shows "Add a host" (primary) and "Try demo hosts" (secondary). The flow also models camera states for the polish phases' presentation: `priming` (before the system prompt), `denied`, `unavailable`. Views live in `apps/mobile/src/pairing/screens/` (`choose-method.tsx`, `scanner.tsx`, `paste.tsx`, `preview.tsx`, `waiting.tsx`, `result.tsx`); the state machine in `apps/mobile/src/pairing/flow.ts` (`idle → scanning|pasting → previewing → waiting → paired|failed`), tested without a router; `after-pair.ts` exports `afterPair(router, result)` which replaces to `/(hosts)`.
  - Scanner: `expo-camera` `CameraView` with `barcodeScannerSettings: { barcodeTypes: ["qr"] }`; the first QR whose text starts with `SGP1:` stops scanning. Permission states as in Test cases. No camera device shows the unavailable message.
  - Device name and model come from `expo-device` (`deviceName ?? "iPhone"`, `modelName ?? "iPhone"`).
  - Copy for failures comes from `remoteErrorText`/`remoteErrorAdvice`-style functions in `@core/remote-errors`; add phone pairing advice (`pairingAdvice(error, host)`) there, next to `PAIRING_FAILURE_TEXT`, with each failure's recovery ("Start pairing again on <host>", "Ask for a new code", "Check the host is reachable on this network").
  - Launch (`index.tsx`): once phase 7's `CoreProvider` has selected the native transport (hosts exist), replace to `/(hosts)`; a core start error renders through `nativeErrorText`/`remoteErrorText` with Retry. The welcome content is a placeholder layout the polish phases restyle; keep the actions.
  - Settings: Appearance is applied from the store by a bridge mounted in the root layout, not as a side effect in the route (architecture M7); a failed data-policy push shows inline in Settings > Data (errors L6); Settings > Data keeps the one switch phase 7 lane k wired, "Live updates on cellular" (tests audit M7 is resolved by wiring it, D-152).
  - Persistence in `phone-settings.tsx`: `expo-file-system` `Paths.document/phone-settings.json`, read once at provider mount (render children after the read resolves, at most one frame), write debounced 500 ms, write errors logged once per session. Tests inject a storage adapter prop, not a module mock.
  - `host-settings.tsx`: Remove calls `removeHost` when the transport is native, then updates settings; failures show `remoteErrorText`. Adds the "Update from Mac" row.
  - `update-from-mac.tsx`: "Not built yet" placeholder with the RFC sentence of what it will do.
  - `settings/device.tsx`: the key line in a selectable caption, Copy via `expo-clipboard` only if already installed, otherwise `Share.share`; keeps `AppLockSetting`.
- **Decisions already made:** one OS-neutral flow (the user's decision; the lane writes the D-entry in `plan/decisions.md` and changes RFC 1.3 and 2.4's "Pair with your Mac" / "Add a Linux server" wording in `plan/rfc-ios-app.md` to "Add a host": "one Add a host flow; handover is a payload capability, never an OS check"); the simulator path is Paste; `SGPDEMO:` payloads exist only in `__DEV__` and jest; Cancel does not tell the host (its offer expires; RFC 2.4); handover of other hosts is phase 9.
- **Out of scope:** connection error rendering (phase 7 lane f), visual polish of these screens (phase 11, from `plan/rfc-ios-polish.md`), Rust.
- **Done when:** the table's Done-when conditions are met, with simulator screenshots (light, dark) of every pairing step against the Docker host and of each `SGPDEMO:` failure.

#### Lane d brief

- **Goal:** the app pulls data only for what is on screen, in the foreground: compact live for visible hosts-list rows, full for the focused host screen or module page, nothing for Settings, pairing, welcome or debug, nothing in the background.
- **Interface:** `useFocusDemand`, `useVisibleHosts`, `MobileCall::SetDemand`, `PARK_GRACE`, `demand::admit`.
- **Behavior:**
  - TS: a small store of demand entries keyed by screen instance; `useFocusDemand` adds on focus and removes on blur (React Navigation's `useFocusEffect`), and the store sends the union. The data hooks declare demand themselves: `useHostVitals`/`useHostSparkline` (compact, only while the row is visible), `useHostLiveSubscription` (full, only for the pager's current page; `host/index.tsx` provides that through a context), `useModuleHistory` (full). No screen component calls the store.
  - Rust: `set_demand` diffs against the current demand; added hosts resume (`full`: `Subscribe { Live1s }`, or `compact` when `live_allowed` is false; `compact`: `Interest { detail: false }` so the host sends a `HostSummary` every 5 s; a compact host never subscribes `Live1s`, and its sparkline history is the row hook's `Query::History`); dropped hosts get a `PARK_GRACE` timer, cancelled if re-demanded, then `quiesce()`. `admit` parks a new source when the core is backgrounded or the host is not demanded, and the `expect(dead_code)` on `Lifecycle::backgrounded` goes. `resume` after background resumes only demanded sources, the open host's first.
  - Process interest: `apps/mobile/src/data/processes.ts` exports `useProcessDemand(host, view)`, which sets `RemoteInterest` process flags through `setProcessInterest` on focus of a screen that renders a live process table and clears them on blur; nothing else sets them. The call is `MobileCall::SetProcessInterest`, declared in the phase 7 scaffold; this lane implements it in `crates/statglass-mobile/src/sessions/processes.rs` over the session's interest, so the polish phases add no Rust for it.
  - Summaries: the hosts-list hooks append each `HostSummary` to the row's series (values and sparkline every 5 s); the row says nothing about the cadence, and the status still reads Live.
  - Verify on an iOS 27 simulator that quiesce and the snapshot cover fire on scene background, not on a Notification Center pull (architecture M13); if not, move `AppLifecycle.swift` to scene notifications in this lane and say so.
  - Swift: unchanged unless the M13 check fails; `AppLifecycle.swift` keeps `beginBackgroundTask` plus `quiesce`. No `UIBackgroundModes`, no BGTask identifiers.
- **Decisions already made:** demand is declared in the data layer, driven by focus (the user's instruction: no per-screen effects). The hosts list's sparklines show the last 30 minutes from one scoped `Query::History` per visible row (D-152), not from `RecentRequest`, which can't be scoped to the row's series. Hosts-list rows update every 5 s, the host's `HostSummary` period; the user confirmed 5 s is fine (10 s would be too), so there is no wire change for it. `PARK_GRACE` is 15 s, for the reason in its doc comment. The Rust test `quiesce_and_resume_update_the_backgrounded_flag` is deleted (tests audit L8): the observable tests cover it.
- **Out of scope:** what each screen renders, pairing, wire changes.
- **Done when:** the table's Done-when conditions are met.

#### Lane e brief

- **Goal:** the Mac shows local and public addresses for every host it monitors, not only itself, from the same host-served answer the phone uses.
- **Interface:** `get_host_addresses`, `Transport.getHostAddresses`, `useAddresses(primary)`.
- **Behavior:**
  - Route by host as the other per-host commands do (`commands.rs`'s `Route::Remote(source)` pattern): remote hosts call `source.network_addresses()`; this Mac calls `statglass_remote::addresses` directly. Chosen over keeping `src-tauri/src/addresses.rs`'s separate local path because it leaves one answer shape, one public-IP cache on the host side, and one TS path, instead of two commands and a TS-side cache keyed by interface. `src-tauri/src/addresses.rs` is already a thin delegate after phase 7 lane h.
  - `useAddresses` drops `useIsLocalHost()`. `RemoteUnsupported` means no address row, silently. `pending` polls every 2 s, at most 5 times, while the surface is shown; a hidden window pauses it as today.
  - The three surfaces (`address-line.tsx`, `machine-live-specs.tsx`, the popover Network card) keep their layout; only the data source changes.
  - The mock serves addresses for every demo host and one old host without the feature, in the same change (`data-boundary.md`).
- **Decisions already made:** the user's 2026-11-25 decision that the Mac shows remote hosts' addresses; D-153's public-IP rule applies to every host and is enforced on the host, so the desktop adds no client-side public-IP cache.
- **Out of scope:** the phone's Network page (phase 12), the resolver (phase 7 lane h).
- **Done when:** the table's Done-when conditions are met.

### Phase 9: the Mac hands its other hosts to the phone

Demo:
- **Rust, Docker (`make ssh-docker-test`, `docker_handover`):** the fixture's `ssh_config` alias resolves through `ssh -G -F <config>` and `ssh-keygen -F` into a `BundleHost`; an install intent for a phone key is applied over the fixture's full-access SSH by running the agent's `authorize-key`, after which a phone session with that key streams through the restricted forced command. A revoke recorded while the container is stopped is applied when it comes back and supersedes the earlier install: the key is refused.
- **Simulator, Docker as the handed-over Linux host:** copy the phone's key line from Settings > This iPhone; `cargo run -p statglass-remote --example handover-bundle -- --ssh-config <fixture>/ssh_config --alias <alias> --key "<line>"` applies the install and prints an `SGB1:` bundle; Settings > Hosts > "Update from Mac" > Paste lists the container as new with a checkbox; adding it lands it Live in the hosts list. A second bundle without it marks it "Removed on your Mac".
- **Mac (browser dev server, mock transport):** Paired devices shows pending intents per host ("revoke pending: build-server offline"); "Update iPhone" shows the bundle QR with the hosts that cannot be handed over and why. `tests/e2e/settings-handover.spec.ts` covers it.
- **Not run:** pairing against this Mac with Remote Login on (the run does not change the user's security settings); the Mac-side apply path runs in Rust tests against the Docker fixture through the same code the app calls.

Depends on: phase 5, phase 8

Scope, from RFC 2.4 steps 4-5, "Building the bundle", "Keeping the list current", the manual-pairing `authorize-key` path, and RFC 2.6.

Test cases:

**Intent log (`statglass-remote::intents`)**
- `record` appends one JSON line per intent with a sequence number that increases per log, survives reopen, and fsyncs before returning.
- `pending()` returns, per `(host, device)`, only the highest-sequence intent that is not applied: install then revoke gives the revoke; revoke then install (a re-pair) gives the install; an applied revoke followed by nothing gives nothing.
- `mark_applied(seq)` of a superseded intent is a no-op; `mark_failed(seq, reason)` keeps it pending with the reason and attempt count.
- A truncated last line (crash mid-write) is ignored with one log line; earlier lines load. Unknown fields are ignored; an unknown `op` line is skipped and logged.
- The file is 0600 in the app's data directory; writes take the same advisory lock pattern as `authorized_keys`.

**Bundle resolution (`statglass-remote::ssh_config`)**
- `parse_ssh_g` reads `hostname`, `user`, `port`, `proxyjump`, `proxycommand` (lowercase keys, `none` values) from captured `ssh -G` output.
- `handover_host` returns `Unavailable` with `ProxyJump`, `ProxyCommand`, `LanLiteral` (an RFC 1918, link-local or CGNAT literal `HostName` with no Tailscale route), `NoHostKey` (`ssh-keygen -F` finds none, hashed or not) or `Unresolvable` (`ssh -G` fails), in that precedence; otherwise a `BundleHost` with the remote host's id, name, OS, user, port, targets (LAN then Tailscale alias, resolved names) and SHA-256 fingerprints from `ssh-keygen -lf -`.
- Hashed `known_hosts` entries and `[host]:port` entries are found.

**Authorize and revoke on hosts**
- Helper `authorize-key --key <base64 SEC1> --name <name>` and `revoke-key --device <tag>`, and agent `authorize-key`/`revoke-key [--system|--socket P]`: write or remove the same restricted line pairing writes (lane a's `DeviceKeys`), print the tag, exit 0; a malformed key exits 2; a revoke of an absent tag exits 0 (idempotent, so a replayed revoke settles).
- They run only under a full key (they are not in the restricted token table); a restricted session sending them exits 2.

**Mac**
- On `pairing_approve`, the Mac resolves every enabled remote host, records an install intent for each resolvable one, and the `Approved` reply carries `hosts` (this Mac first) and `unavailable` with reasons.
- The applier runs on connect and every 5 minutes for hosts with pending intents, over the Mac's existing SSH access (`ssh <alias> <helper|agent> authorize-key ...`), marks applied or failed with the reason, and never blocks the registry.
- `revoke_device` on the Mac records a revoke intent for every host that had an install for that tag; Paired devices lists pending intents per host with the reason.
- `handover_bundle_start` returns `HandoverOffer { text, qr_svg, hosts, unavailable, issued_ms }` with no pairing key; the bundle QR is under 1.2 KB for ten hosts.
- The mock mirrors every new command; Playwright covers the panel and the Update sheet.

**Phone**
- `decode_bundle` round-trips `SGB1:` text; a pairing payload pasted into Update from Mac, and a bundle pasted into Pair, each fail with a typed `invalid` and the screen says which kind of code it wants.
- After pairing a Mac whose reply carries other hosts, the phone shows "Also on <Mac>" with a checkbox per host (all checked) and the unavailable ones with their reason; "Add" adds the checked hosts (restricted command, pinned keys) and persists them; "Skip" adds none.
- Update from Mac: reconcile against the current list by host id: new hosts offered with checkboxes, hosts no longer in the bundle marked "Removed on your Mac" (kept, with Remove), unchanged hosts untouched, changed targets or keys updated in place.
- A handed-over host whose install is still pending on the Mac fails `remote_auth` with no `last_seen_ms`, so it shows "Key not accepted by sshd" until the Mac applies it, then connects on retry.
- Proto skew: a phase 5 `PairReply::Approved` without `unavailable` decodes on the new phone, and the new reply decodes on a phase 5 phone (unknown field ignored).

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | crates/statglass-remote/src/ssh_config.rs, crates/statglass-remote/src/ssh_config/, crates/statglass-remote/src/intents.rs, crates/statglass-remote/src/intents/, crates/statglass-remote/src/pairing.rs, crates/statglass-remote/tests/intents.rs, crates/statglass-remote/tests/ssh_config.rs, crates/statglass-remote/tests/docker_handover.rs, crates/statglass-remote/examples/handover-bundle.rs, crates/statglass-agent/src/authorize.rs, crates/statglass-agent/tests/authorize.rs, crates/statglass-remote-helper/src/authorize.rs, crates/statglass-remote-helper/tests/authorize.rs | contracts, RFC 2.4, 2.5, 2.6 | intent log, resolution, authorize/revoke, Docker handover | gpt-6.2-sol | pending | | `cargo test -p statglass-remote -p statglass-agent -p statglass-remote-helper` pass; `make ssh-docker-test` passes `docker_handover`; clippy clean |
| b | L | src-tauri/src/handover.rs, src-tauri/src/handover/, src/app/routes/dashboard/settings/_components/device-intents/, src/app/routes/dashboard/settings/_components/update-from-mac/, src/desktop-transport/native-handover.ts, packages/core/src/mock/handover.ts, packages/core/src/mock/handover.test.ts, tests/e2e/settings-handover.spec.ts | contracts, RFC 2.4, 2.6, plan/design-system.md | src-tauri handover tests, Vitest panel/sheet/mock, Playwright | gpt-6.2-sol | pending | | `cargo test -p statglass handover`, `bun run typecheck`, `bun run test`, `tests/e2e/settings-handover.spec.ts` pass; screenshots compared to Paired devices |
| c | L | crates/statglass-proto/src/handover.rs, crates/statglass-proto/tests/handover_skew.rs, crates/statglass-session/src/handover.rs, crates/statglass-mobile/src/handover.rs, apps/mobile/src/handover/, apps/mobile/src/transport/handover.ts, apps/mobile/src/app/update-from-mac.tsx, apps/mobile/src/app/pair-hosts.tsx, apps/mobile/src/pairing/after-pair.ts, apps/mobile/test/handover/ | contracts, RFC 2.4 | bundle codec and skew, reconcile, phone screens | gpt-6.2-sol | pending | | `cargo test -p statglass-proto -p statglass-session -p statglass-mobile handover`, `bun run --cwd apps/mobile test -- test/handover`, `make mobile-check`, `make mobile-rust-check`; the simulator Demo above |

Ownership: phase 9 can run beside the design-parity phases that `plan/rfc-ios-polish.md` proposes, which must not own these paths. Phase 8 needs none of the polish work's files (`apps/mobile/src/app/_layout.tsx`, `apps/mobile/src/app/settings/`, `apps/mobile/src/pairing/screens/`): its two routes set their own header options (phase 11 lane a, which depends on phase 9, later moves them onto the shared `screenOptions` and back chevron), the Settings entry point is the "Update from Mac" row phase 8 added (the RFC's host detail page links to `/update-from-mac`), and the pairing flow reaches `pair-hosts` through `after-pair.ts`. Phase 5 lane c's `src-tauri/src/pairing/`, `paired-devices/` and the settings `route.tsx` are merged; phase 9's scaffold mounts `device-intents/` and `update-from-mac/` there and adds the `HandoverSource` call in `src-tauri/src/pairing.rs`.

#### Scaffold contracts (phase 9)

The scaffold runs `make bindings`, then the typecheck, and fixes what it flags. No new crate edges: the Mac reaches intents and resolution through `statglass-remote`, the phone reaches the bundle codec through proto and session.

```rust
// crates/statglass-proto/src/handover.rs (lane c fills the codec)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoverReason { ProxyJump, ProxyCommand, LanLiteral, NoHostKey, Unresolvable }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnavailableHost { pub host_id: HostId, pub name: String, pub reason: HandoverReason }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostBundle { pub version: u8, pub from: HostId, pub hosts: Vec<BundleHost>, pub unavailable: Vec<UnavailableHost>, pub issued_ms: i64 }
pub fn encode_bundle(b: &HostBundle) -> String;                    // "SGB1:" + base45(cbor), reusing pairing's base45
pub fn decode_bundle(s: &str) -> Result<HostBundle, PairError>;    // stub: Err(PairError::Invalid)
// crates/statglass-proto/src/pairing.rs: PairReply::Approved gains
//   #[serde(default, skip_serializing_if = "Vec::is_empty")] unavailable: Vec<UnavailableHost>

// crates/statglass-remote/src/intents.rs (lane a)
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum IntentOp { Install { key: String /* base64 SEC1 */, name: String }, Revoke, Applied { seq: u64 }, Failed { seq: u64, reason: String } }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntentRecord { pub seq: u64, pub host: HostId, pub device: String /* DeviceTag */, #[serde(flatten)] pub op: IntentOp, pub at_ms: i64 }
pub struct IntentLog { /* path */ }
impl IntentLog {
    pub fn open(path: PathBuf) -> Result<Self, IntentError>;
    pub fn record(&self, host: HostId, device: DeviceTag, op: IntentOp, now_ms: i64) -> Result<u64, IntentError>;
    pub fn pending(&self) -> Result<Vec<PendingIntent>, IntentError>; // effective, unapplied, per (host, device)
    pub fn mark_applied(&self, seq: u64, now_ms: i64) -> Result<(), IntentError>;
    pub fn mark_failed(&self, seq: u64, reason: &str, now_ms: i64) -> Result<(), IntentError>;
}
pub struct PendingIntent { pub seq: u64, pub host: HostId, pub device: DeviceTag, pub install: Option<(EcdsaP256Public, String)>, pub attempts: u32, pub last_error: Option<String> }
#[derive(Debug, thiserror::Error)] pub enum IntentError { #[error("intent log: {0}")] Io(#[from] std::io::Error), #[error("intent log: {0}")] Invalid(String) }
```

Intent log format: JSON Lines at `~/Library/Application Support/com.tryopendata.statglass/device-intents.jsonl`, one `IntentRecord` per line, for example `{"seq":12,"host":"<uuid>","device":"7F3A2C","op":"install","key":"BHd…","name":"Riley's iPhone","at_ms":1795000000000}`, `{"seq":13,"host":"<uuid>","device":"7F3A2C","op":"revoke","at_ms":…}`, `{"seq":14,"host":"<uuid>","device":"7F3A2C","op":"applied","seq_applied":13,…}` (the `Applied`/`Failed` payload field is `seq` inside the op, serialized as `applied_seq`/`failed_seq` via `#[serde(rename)]`). Append-only; compaction past 256 KiB under the lock keeps the effective record and last outcome per `(host, device)`.

```rust
// crates/statglass-remote/src/ssh_config.rs (lane a)
pub struct ResolvedAlias { pub hostname: String, pub user: String, pub port: u16, pub proxy_jump: Option<String>, pub proxy_command: Option<String> }
pub fn parse_ssh_g(output: &str) -> Result<ResolvedAlias, SshConfigError>;
pub fn resolve(alias: &str, config: Option<&Path>) -> Result<ResolvedAlias, SshConfigError>;         // /usr/bin/ssh -G [-F config]
pub fn known_host_keys(host: &str, port: u16, known_hosts: Option<&Path>) -> Result<Vec<BundleHostKey>, SshConfigError>;
pub fn handover_host(remote: &HandoverInput, config: Option<&Path>) -> Result<BundleHost, HandoverReason>;
pub struct HandoverInput { pub host_id: HostId, pub name: String, pub os: String, pub lan: Option<String>, pub tailscale: Option<String> }
#[derive(Debug, thiserror::Error)] pub enum SshConfigError { #[error("ssh -G: {0}")] Resolve(String), #[error("ssh-keygen: {0}")] Keys(String), #[error(transparent)] Io(#[from] std::io::Error) }

// crates/statglass-remote/src/pairing.rs: the hook the Mac fills (lane a calls it in approve)
pub struct Handover { pub hosts: Vec<BundleHost>, pub unavailable: Vec<UnavailableHost> }
pub trait HandoverSource: Send + Sync { fn handover(&self, device: DeviceTag, key: &EcdsaP256Public, name: &str) -> Handover; }
impl PairingHost { pub fn set_handover(&self, source: Arc<dyn HandoverSource>); } // default: none (agent pairing hands over nothing)

// crates/statglass-agent/src/cli.rs and crates/statglass-remote-helper/src/main.rs
DeviceCommand::AuthorizeKey { key: String, name: String, system: bool, socket: Option<PathBuf> }, DeviceCommand::RevokeKey { tag: String }
// helper: `authorize-key --key K --name N`, `revoke-key --device T` dispatch to authorize.rs stubs (exit 2)

// crates/statglass-ipc/src/error.rs
CommandError::Handover { message: String } // resolving, applying or encoding a handover failed

// crates/statglass-ipc/src/mobile.rs
MobileCall::DecodeBundle { text: String },             // -> BundleReconcile
MobileCall::AddHandoverHosts { hosts: Vec<OfferedHost> }, // -> null; persisted like Pair
PairedHost gains `offered: Vec<OfferedHost>, unavailable: Vec<UnavailableHostInfo>`
pub struct OfferedHost { pub id: HostId, pub name: String, pub os: String, pub user: String, pub port: Option<u16>, pub targets: Vec<MobileTarget>, pub host_keys: Vec<MobileHostKey> }
pub struct UnavailableHostInfo { pub id: HostId, pub name: String, pub reason: HandoverReasonInfo } // snake_case mirror of HandoverReason
pub struct BundleReconcile { pub from: HostId, pub new: Vec<OfferedHost>, pub removed: Vec<HostId>, pub changed: Vec<HostId>, pub unavailable: Vec<UnavailableHostInfo> }
// MobileHost gains #[serde(default)] removed_by_controller: bool ("Removed on your Mac")

// src-tauri/src/handover.rs (lane b), registered in collect_commands!
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct HandoverOffer { pub text: String, pub qr_svg: String, pub hosts: Vec<String>, pub unavailable: Vec<HandoverUnavailableInfo>, pub issued_ms: JsSafeInt }
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct DeviceIntentInfo { pub host: HostId, pub host_name: String, pub device: String, pub device_name: String, pub op: String /* install | revoke */, pub state: String /* pending | failed */, pub reason: Option<String>, pub attempts: u32 }
pub async fn handover_bundle_start(state: State<'_, HandoverState>) -> Result<HandoverOffer, CommandError>;     // stub: Err(Handover)
pub async fn device_intents(state: State<'_, HandoverState>) -> Result<Vec<DeviceIntentInfo>, CommandError>;  // stub: Ok(vec![])
pub async fn retry_device_intents(state: State<'_, HandoverState>) -> Result<(), CommandError>;               // stub: Ok(())
```

TypeScript: `Transport` gains `handoverBundleStart`, `deviceIntents`, `retryDeviceIntents` (desktop-only, not in `PhoneTransport`); the mock wires `packages/core/src/mock/handover.ts` (stub, lane b); `app-transport.ts` delegates to `native-handover.ts` (stub). The phone's `apps/mobile/src/transport/handover.ts` (lane c) exports `nativeHandover(core): { decodeBundle(text), addHandoverHosts(hosts) }`. `crates/statglass-mobile/src/mobile_core.rs` routes the two calls to `handover.rs` (stubs returning `internal`).

#### Lane a brief

- **Goal:** the host-side and controller-side pieces of handover: the durable intent log, alias resolution into bundle hosts with reasons, `authorize-key`/`revoke-key` on the helper and agent, the approve hook, and the Docker proof.
- **Behavior:** as Test cases. `handover_host` checks in the precedence listed and never dials. `authorize-key` reuses `DeviceKeys::add_device` with the same command string pairing writes, so a phone sees one line whoever installed it. `approve` calls the `HandoverSource` (if set) after writing this host's device line and before replying; a panicking or slow source is not possible because the trait is synchronous and the Mac's implementation only resolves and records (applying is async, lane b). `examples/handover-bundle.rs` takes `--ssh-config`, `--alias`, `--key` (an `authorized_keys` line), records and applies the install over `ssh -F`, and prints the `SGB1:` text (it uses `encode_bundle` once lane c lands; until then a scaffold-owned stub prints the bundle JSON).
- **Decisions already made:** a revoke always supersedes an earlier install per `(host, device)`; intents live on the Mac only; the agent pairing hands over nothing.
- **Out of scope:** the Mac's commands and UI (lane b), the bundle codec and the phone (lane c).
- **Done when:** the table's Done-when conditions are met.

#### Lane b brief

- **Goal:** the Mac records and applies intents, answers approval with other hosts, shows pending intents, and offers "Update iPhone" bundles.
- **Behavior:** `HandoverState` owns an `IntentLog` at the app data directory and implements `HandoverSource` over the remote registry's enabled hosts (resolution through `ssh_config::handover_host` with the user's own config). An applier task, started in setup, runs pending intents for a host when it connects and every 5 minutes, through the registry's existing SSH runner, with a 20 s timeout per host; results go to `mark_applied`/`mark_failed`. `revoke_device` (phase 5 command) also records revoke intents. Settings: `device-intents/` lists pending and failed intents under Paired devices with Retry; `update-from-mac/` is the "Update iPhone" sheet showing the QR, the hosts and the unavailable list with reasons; both use the Paired devices panel's components and copy style.
- **Out of scope:** resolution and log internals (lane a), the phone (lane c).
- **Done when:** the table's Done-when conditions are met, with browser screenshots compared against the Paired devices panel and `plan/design-system.md`, every difference named.

#### Lane c brief

- **Goal:** the phone can take other hosts from a Mac at pairing time and from an Update bundle, and reconcile.
- **Behavior:** `decode_bundle`/`encode_bundle` (proto) with the round-trip and skew tests; `statglass-session::handover::reconcile(current: &[MobileHost], bundle: &HostBundle) -> BundleReconcile`; facade `DecodeBundle` and `AddHandoverHosts` (persist through the phase 8 `HostStore`). Phone: `pair-hosts.tsx` renders the "Also on <Mac>" chooser from `PairedHost.offered/unavailable`; `after-pair.ts` routes there when the payload had `can_hand_over` and `offered` or `unavailable` is non-empty ("Also add the N hosts this Mac monitors"), else to `/(hosts)`; nothing reads the host's OS; `update-from-mac.tsx` takes Scan or Paste (the phase 8 scanner and paste views, imported), shows the reconcile with checkboxes and "Removed on your Mac" marks, and applies. Copy for each `HandoverReason` lives in `@core/remote-errors` (`handoverReasonText`).
- **Out of scope:** the Mac (lanes a and b), restyling the pairing views (the polish phases).
- **Done when:** the table's Done-when conditions are met.

### Phase 10: design primitives

Demo:
- **Simulator, dev route `/dev/primitives` (debug builds only, removed in phase 11):** every primitive on one scrolling screen in light, dark and AX1: the eleven text variants with their sizes, the header button and back chevron with their 44 pt hit areas outlined, a grouped list with plain, value, checkmark, chevron and destructive rows, a swipe row that reveals Remove, a five-row `ReorderList` that lifts with a haptic and reorders, a segmented control whose thumb slides, a sheet, the CPU and memory sparklines with a corner ceiling, mirrored `Sparkbars`, a heat matrix and two ring gauges on the shared fixtures. Scrolling it puts content under the status bar with the system chrome material behind it.
- **Desktop:** the dev gallery's ring gauge, heat matrix and module hero sections render as before (screenshots before and after, no difference), and `make e2e-perf` is reported before and after.
- **Text:** no screen renders weight 700; headline figures are SF Pro Rounded with tabular digits.

Depends on: phase 8

Why the primitives are a phase of their own: every surface in phases 11 and 12 renders through them, so building them once keeps those lanes disjoint (`plan/rfc-ios-polish.md` section 5). Phase 10 runs beside phase 9, so it owns none of phase 9's files (`update-from-mac.tsx`, `pair-hosts.tsx`, `pairing/after-pair.ts`, `handover/`, `transport/handover.ts`, `test/handover/`, and phase 9's Rust and desktop files), and its scaffold adds no `MobileCall` variant.

Code facts this phase relies on (checked 2026-11-25 against the tree, stated as the state after phases 7 and 8 land):
- **Text.** `apps/mobile/src/ui/text.tsx` has seven roles. `largeTitle` and `title` are `font-bold` (700), `cardTitle` is 17 pt, `cardFigure` is 28 pt with `tabular-nums` and no rounded face. The prop is `role`, which shadows React Native's ARIA `role`; 96 call sites in 29 files set it, many through a `{...{ role: "body" }}` spread (architecture M1). Phases 7, 8 and 9 add more call sites, including phase 9's `update-from-mac.tsx` and `pair-hosts.tsx`.
- **Chrome is hand-drawn per screen.** The hosts route draws an inline SVG gear and a plain-text "Demo" label in `unstable_headerLeftItems` (`(hosts)/index.tsx`). Settings has its own chevron (`settings/index.tsx`), host rows another (`hosts/host-row.tsx`), cards a third (`cards/module-card.tsx`). After phase 7 lane a, header colors come from the navigator theme (`navigationTheme(scheme)`, `useThemeColors()` in `apps/mobile/src/ui/`) and no screen sets `headerTintColor`.
- **The grouped-list markup is repeated** about 14 times (`rounded-xl border border-border bg-card` with separators) across the settings routes, `host-row`, `host-settings`, the lock screens and the debug screen (architecture M3).
- **No reorder, sheet or segmented primitive exists.** `module/range-control.tsx` is a bordered row of `Pressable`s. `host/card-menu.tsx` is a React Native `Modal` with "Move up"/"Move down".
- **Dependencies.** Installed: `expo-haptics`, `expo-blur`, `react-native-gesture-handler` ~3.3, `react-native-reanimated` 4.7.1, `react-native-svg`. Not installed: `expo-symbols` (the RFC's icon source), `expo-localization` (phase 12's temperature unit), `react-native-reorderable-list`. `ActionSheetIOS` ships with React Native.
- **Axis ticks.** Core has `niceCeiling` (`chart-math/nice-ceiling.ts`) and the desktop has `ceilingAxis`, `windowTicks` and `historyTicks` in `src/app/widgets/lib/chart-labels.ts`. No core module produces labelled value and time ticks.
- **Module specs.** `CPU_HERO`, `GPU_HERO`, `MEMORY_PRESSURE_HERO`, `BATTERY_HERO`, `POWER_HERO`, `NETWORK_HERO`, `memoryUsedHero` and `memoryHero` live in `src/app/components/module-hero.ts` (181 lines, with a test), imported by ten desktop files.
- **Heat and ring.** The desktop renders `src/app/widgets/heat-matrix.tsx` (310 lines, `HeatMatrixProps`, `HeatScaleLegend`) and `ring-gauge.tsx` (123 lines, `RingGaugeProps`, sizes 88 and 112). Their math is partly in core already (`chart-math/heatmap.ts` `heatmapAlpha`, `chart-math/ring.ts` `ringArcs`); labels, legend, spoken text and cell layout are in the components. `core-heatmap.tsx` and `ring-stat-card.tsx` compose them. The phone has neither.
- **Sparklines.** The phone's `widgets/stream-area.tsx` (over core `streamAreaModel`) places its ceiling label above the plot, about 40 pt from the top gridline on the CPU card (audit item 8). `widgets/mirror-bars.tsx` draws both directions in the full-saturation accent with no labels (item 12). `test/widgets/bars/bars.test.tsx` asserts `className` and `testID` order (tests audit L3).
- **Shared-package rules.** `packages/core/README.md`: pull never push, fork instead of flag, tested once and rendered twice; forks are listed under "Forks".

Test cases:

**Scaffold: text variants**
- `apps/mobile/test/ui/text.test.tsx`: each variant renders the size, weight and style of the RFC 1.4 table (`plan/rfc-ios-polish.md` section 3): no variant has weight 700; `cardFigure` and `heroFigure` set `fontFamily: "ui-rounded"` and `fontVariant: ["tabular-nums"]`; `value` and `axis` are tabular; `axis` sets `maxFontSizeMultiplier` 1.5; `largeTitle`, `title` and `onboardingTitle` announce as headers.
- A grep test fails on a `{...{ role:` spread anywhere in `apps/mobile/src`.

**Chrome (lane a)**
- `HeaderButton`: a 28 pt icon inside a 44 by 44 pt pressable, tinted `foreground` from `useThemeColors()`, with no fill; its accessibility label is required by type.
- `BackButton`: chevron only, no text, `accessibilityLabel="Back"`, 44 pt; pressing calls `router.back()`. `useAccessibilityEscape(onEscape)` sets `onAccessibilityEscape` on the screen root and calls back.
- `screenOptions(colors)`: `headerTransparent: true`, `headerBlurEffect: "systemChromeMaterial"`, `headerLargeTitleShadowVisible: false`, `headerBackVisible: false` with `headerLeft` rendering `BackButton` on pushed screens, title style weight `"600"`, and the same values in light and dark except colors.
- `ScreenScroll`: a `ScrollView` with `contentInsetAdjustmentBehavior="automatic"`; a `headerShown: false` variant clips at the top safe-area inset instead.
- `Icon`: every `IconName` maps to an SF Symbol through `expo-symbols`; a test renders each name. No `Svg` chevron or gear remains in `ui/`.
- `GroupedList`, `ListSection` (header in `cardTitle`, optional footer in `caption`), `ListRow` (glyph, title, subtitle, value right-aligned in `value`, accessory chevron or checkmark, destructive variant in `--color-destructive`, never cyan; at least 44 pt tall at AX1); a checkmark row announces as selected.
- `SwipeRow`: a trailing destructive action through Gesture Handler's `ReanimatedSwipeable`; VoiceOver gets the same action as a custom action.
- `DemoBadge`: a "Demo" chip button; pressing opens `ActionSheetIOS` with "Exit demo" (destructive) and Cancel; Exit calls `onExit`.

**Interaction (lane b)**
- `ReorderList` over `react-native-reorderable-list` (or the fallback named in the scaffold's report):
  - a long press lifts the item with a medium haptic, moving reorders, and the drop fires a light haptic and `onReorder(ids)` once with the new order;
  - a long press released without movement calls `onReleaseWithoutMove(id)` and not `onReorder`;
  - VoiceOver custom actions "Move up" and "Move down" call `onReorder` with the item moved one place; the first item has no "Move up", the last no "Move down";
  - `nested` renders `NestedReorderableList` for use inside a `ScreenScroll`.
- `SegmentedControl`: `accessibilityRole="tablist"`, each segment a 44 pt `tab` with `selected` state; the thumb slides over the motion token's 150 ms and moves at once under Reduce Motion or Low Power Mode (`ui/motion.tsx`).
- `Sheet`: a native page sheet (`Modal` with `presentationStyle="pageSheet"`) with a title and a Done button; Done and the swipe-down both call `onClose`.

**Axis ticks and module specs (lane c)**
- `valueTicks(ceiling, format, opts)`: 0, the midpoint and the ceiling for percent, bytes, rate and watts, with labels from `@core/format`; a ceiling of 0 or a non-finite one returns one tick at 0.
- `timeTicks(fromMs, toMs, widthPx, opts)`: labels at clock-aligned steps for 5 m, 1 h, 24 h, 7 d and 30 d, in host time through `clockOffsetMs`; fewer ticks at larger `captionScale` so labels never overlap at a given width; the right edge is labelled "now" only when `toMs` is now.
- `packages/core/src/module-hero.test.ts` is the moved `src/app/components/module-hero.test.ts`, unchanged in assertions. Desktop importers keep `~/components/module-hero`, now a re-export; `bun run test -- src/app` passes unchanged.

**Heat and ring models (lane d)**
- `heatMatrixModel` and `ringGaugeModel` produce, from `widget-models/fixtures/heat-ring.ts`, the cells, alphas, legend labels, current values and spoken text the desktop components render today; one test file asserts the models.
- The desktop `heat-matrix.tsx` and `ring-gauge.tsx` render the models; `src/app/widgets/heat-matrix.test.tsx`, `ring-gauge.test.tsx`, `core-heatmap.test.tsx` and `ring-stat-card.test.tsx` pass unchanged; the gallery renders unchanged.
- Phone twins `widgets/heat-matrix.tsx` and `widgets/ring-gauge.tsx` render the same fixtures; tests assert accessible names and values from the model (not class names), and that a `null` cell is drawn as a gap, not a zero.
- `formatTemperature` units pass through: a model given `units: "F"` labels the legend and current values in °F.

**Sparklines (lane e)**
- `StreamArea` with `variant="spark"`: no axes, the ceiling label in `axis` at the top-left corner on the top gridline; with `variant="chart"` the ceiling label sits on the top gridline, not above it (item 8). Accessible values unchanged from phase 7's card models.
- `Sparkbars`: mirrored bars on the sparkline scale, download at ramp step 1 below the axis and upload at ramp step 2 above, each direction autoscaled; a `null` bucket draws nothing.
- `MirrorBars` (the card's): ramp steps 1 and 2 instead of the full accent, with "↓ Download" and "↑ Upload" labels from the card model (item 12).
- `bars.test.tsx` drops its `className` assertions and keeps the heights from the model (tests audit L3).

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | apps/mobile/src/ui/header-button.tsx, apps/mobile/src/ui/back-button.tsx, apps/mobile/src/ui/screen-options.ts, apps/mobile/src/ui/screen-scroll.tsx, apps/mobile/src/ui/icons.tsx, apps/mobile/src/ui/grouped-list.tsx, apps/mobile/src/ui/list-row.tsx, apps/mobile/src/ui/swipe-row.tsx, apps/mobile/src/ui/demo-badge.tsx, apps/mobile/test/ui/chrome/ | contracts, `plan/rfc-ios-polish.md` 3, 4.1, 4.7; `plan/design-system.md`; audit-architecture M3 | 44 pt and labelled buttons, blur material, automatic insets, every icon, list rows, swipe action, demo sheet | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/ui`, `make mobile-check`; simulator screenshots of `/dev/primitives` chrome rows in light, dark and AX1, and of a scrolled screen with content under the status bar, compared with the popover header |
| b | M | apps/mobile/src/ui/reorder-list.tsx, apps/mobile/src/ui/segmented-control.tsx, apps/mobile/src/ui/sheet.tsx, apps/mobile/test/ui/interaction/ | contracts, RFC 4.5, 4.7, 5; the scaffold's drag-list and zeego report; `apps/mobile/src/ui/motion.tsx` | reorder, release-without-move, VoiceOver moves, segment thumb, sheet close | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/ui`, `make mobile-check`; simulator recording of a drag reorder and a release-without-move, screenshots in light, dark and AX1 |
| c | M | packages/core/src/chart-math/axis-ticks.ts, packages/core/src/chart-math/axis-ticks.test.ts, packages/core/src/module-hero.ts, packages/core/src/module-hero.test.ts, src/app/components/module-hero.ts, src/app/components/module-hero.test.ts | contracts, `src/app/widgets/lib/chart-labels.ts`, `packages/core/src/chart-math/nice-ceiling.ts`, `packages/core/README.md` | ticks on four units and five ranges, host-clock labels, moved hero test unchanged | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/chart-math packages/core/src/module-hero.test.ts src/app`, `bun run typecheck`, `make mobile-check` |
| d | L | packages/core/src/widget-models/heat-matrix.ts, packages/core/src/widget-models/ring-gauge.ts, packages/core/src/widget-models/heat-ring.test.ts, packages/core/src/widget-models/fixtures/heat-ring.ts, src/app/widgets/heat-matrix.tsx, src/app/widgets/ring-gauge.tsx, apps/mobile/src/widgets/heat-matrix.tsx, apps/mobile/src/widgets/ring-gauge.tsx, apps/mobile/test/widgets/heat-ring/ | contracts, `.claude/skills/widget-model/`, `packages/core/README.md`, `src/app/widgets/core-heatmap.tsx`, `ring-stat-card.tsx` | models tested once, desktop tests unchanged, phone twins on the same fixtures | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/widget-models src/app/widgets`, gallery and render-count e2e, `make e2e-perf` (before and after), `bun run --cwd apps/mobile test -- test/widgets`, `make mobile-check`; desktop gallery screenshots unchanged; phone twins in light, dark and AX1 next to the gallery |
| e | M | apps/mobile/src/widgets/stream-area.tsx, apps/mobile/src/widgets/mirror-bars.tsx, apps/mobile/src/widgets/sparkbars.tsx, apps/mobile/test/widgets/bars/, apps/mobile/test/widgets/charts/, packages/core/README.md | contracts, `packages/core/src/widget-models/stream-area.ts`, `mirror-bars.ts`, `plan/design-system.md` (mirrored bars, ramp steps) | spark variant, ceiling on the gridline, ramp-step bars with labels, L3 cleanup | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/widgets`, `make mobile-check`; simulator screenshots of the CPU and Network cards and the sparklines in light, dark and AX1 next to the popover |

Ownership:
- **The scaffold owns `text.tsx`, every `Text` call site and the manifests.** The rename touches 29 files across every lane's area, so it happens once before dispatch. `apps/mobile/package.json`, `bun.lock`, `apps/mobile/jest.config.cjs` and `apps/mobile/app.config.ts` change only in the scaffold.
- **`role` stays as an alias until phase 11.** Phase 9 runs beside this phase and its files use `role`. The scaffold keeps `role?: TextVariant` on `TextProps` as an alias for `variant` (typed, not a spread), renames every call site outside phase 9's files, and phase 11's scaffold, after phase 9 has merged, renames phase 9's call sites and deletes the alias. This is the one transitional shim in the run; it exists only so phase 9's lane doesn't conflict with this scaffold.
- **Lane e owns `packages/core/README.md`.** It lists a fork there if the spark variant needs a model option only the phone uses. Lane d's models are shared, not forks; if lane d needs a README line it reports the text and the orchestrator adds it at landing.
- **No lane edits `chart-math/index.ts`.** Callers import `@core/chart-math/axis-ticks` by path.
- **The dev route `/dev/primitives`** (`apps/mobile/src/app/dev/primitives.tsx`, `__DEV__` only) is scaffold-owned and renders each lane's stub, so each lane's screenshot shows its own primitive without touching a shared file. Phase 11's lane a deletes it.

#### Scaffold contracts (phase 10)

Inline before dispatch, in this order, each step checked before the next:

1. **Dependencies.** `bunx expo install expo-localization expo-symbols react-native-reorderable-list` in `apps/mobile`, then `bun install`. Confirm `react-native-reorderable-list`'s peer ranges cover Reanimated 4.7 and Gesture Handler 3.3, add it to jest's `transformIgnorePatterns` if needed, render a two-item list under jest and in a simulator build. If it doesn't fit, stop and report: the fallback is a `ReorderList` written on Reanimated and Gesture Handler directly, which replaces lane b with an L lane of its own. Add a plugin entry to `app.config.ts` only if `expo install` asks for one (`expo-localization` doesn't need one to read the locale).
2. **zeego check.** Read zeego's current documentation once for a lift-then-drag handoff from a native context menu to a Gesture Handler or Reanimated drag. If it documents one, switch the card menu plan to zeego, install it here, and say so in the Log; otherwise record "ActionSheetIOS on release, per RFC 4.5" in the Log.
3. **Text.** Write the full `ui/text.tsx` (below) and `test/ui/text.test.tsx`, rename `role` to `variant` at every call site outside phase 9's files, and remove every `{...{ role: ... }}` spread.
4. **Move `host-settings.tsx`.** `apps/mobile/src/hosts/host-settings.tsx` moves to `apps/mobile/src/settings/host-settings.tsx`; `app/settings/hosts.tsx` and its test imports follow. Phase 11 lane a owns `src/settings/`, lane d owns `src/hosts/`.
5. **Stubs** for every signature below, the `/dev/primitives` route, then `bun run typecheck`, `make mobile-check` and `bun run test -- packages/core`.

```ts
// apps/mobile/src/ui/text.tsx (scaffold, complete; RFC 3)
export type TextVariant =
  | "largeTitle" | "title" | "onboardingTitle" | "cardTitle" | "cardFigure" | "heroFigure"
  | "body" | "label" | "value" | "caption" | "axis";
// 34/600, 22/600, 28/600, 13/600, 15/600 rounded tabular, 28/600 rounded tabular,
// 17/400, 13/400 muted, 13/400 tabular, 12/400 muted, 11/400 muted tabular (maxFontSizeMultiplier 1.5)
export type TextProps = Omit<NativeTextProps, "role"> & { variant: TextVariant; /** removed in the phase 11 scaffold */ role?: TextVariant };
export function Text(props: TextProps): JSX.Element;

// apps/mobile/src/ui/icons.tsx (lane a)
export type IconName = "chevron.left" | "chevron.right" | "chevron.down" | "chevron.up" | "gearshape" | "xmark"
  | "ellipsis" | "checkmark" | "line.3.horizontal" | "apple.logo" | "server.rack" | "doc.on.doc";
export function Icon(props: { name: IconName; size?: number; color?: string; accessibilityLabel?: string }): JSX.Element;
// apps/mobile/src/ui/header-button.tsx, back-button.tsx, screen-options.ts, screen-scroll.tsx (lane a)
export function HeaderButton(props: { icon: IconName; accessibilityLabel: string; onPress(): void }): JSX.Element;
export function BackButton(props: { onPress?: () => void }): JSX.Element; // default: router.back()
export function useAccessibilityEscape(onEscape?: () => void): { onAccessibilityEscape(): void };
export function screenOptions(colors: ThemeColors, opts?: { largeTitle?: boolean; root?: boolean }): NativeStackNavigationOptions;
export function ScreenScroll(props: ScrollViewProps & { headerShown?: boolean }): JSX.Element;
// apps/mobile/src/ui/grouped-list.tsx, list-row.tsx, swipe-row.tsx, demo-badge.tsx (lane a)
export function GroupedList(props: { children: ReactNode }): JSX.Element;
export function ListSection(props: { title?: string; footer?: string; children: ReactNode }): JSX.Element;
export interface ListRowProps {
  title: string; subtitle?: string; glyph?: IconName; value?: string;
  accessory?: "chevron" | "checkmark" | "none"; selected?: boolean; destructive?: boolean;
  onPress?: () => void; accessibilityHint?: string; trailing?: ReactNode;
}
export function ListRow(props: ListRowProps): JSX.Element;
export function SwipeRow(props: { children: ReactNode; actionLabel: string; onAction(): void }): JSX.Element;
export function DemoBadge(props: { onExit(): void }): JSX.Element;

// apps/mobile/src/ui/reorder-list.tsx, segmented-control.tsx, sheet.tsx (lane b)
export interface ReorderListProps<T> {
  data: readonly T[]; keyOf(item: T): string; itemLabel(item: T): string; nested?: boolean;
  renderItem(info: { item: T; index: number; isActive: boolean }): ReactElement;
  onReorder(ids: string[]): void; onReleaseWithoutMove?(id: string): void;
}
export function ReorderList<T>(props: ReorderListProps<T>): JSX.Element;
export function SegmentedControl<V extends string | number>(props: {
  segments: readonly { value: V; label: string }[]; value: V; onChange(value: V): void; accessibilityLabel: string;
}): JSX.Element;
export function Sheet(props: { visible: boolean; title: string; onClose(): void; children: ReactNode }): JSX.Element;

// packages/core/src/chart-math/axis-ticks.ts (lane c)
export interface AxisTick { value: number; frac: number; label: string }
export function valueTicks(ceiling: number, format: (value: number) => string, opts?: { count?: number }): AxisTick[];
export function timeTicks(fromMs: number, toMs: number, widthPx: number,
  opts: { clockOffsetMs: number; nowMs: number; captionScale?: number }): AxisTick[];
// packages/core/src/module-hero.ts (lane c): moved unchanged; src/app/components/module-hero.ts re-exports it

// packages/core/src/widget-models/heat-matrix.ts, ring-gauge.ts (lane d); shapes follow today's desktop props
export interface HeatMatrixInput {
  rows: readonly { key: string; label: string; values: readonly (number | null)[] }[];
  domain: readonly [number, number]; format(value: number): string;
}
export interface HeatMatrixModel {
  cells: readonly { row: number; col: number; alpha: number | null }[];
  rows: readonly { key: string; label: string; current: string }[];
  legend: { min: string; max: string }; spoken: string;
}
export function heatMatrixModel(input: HeatMatrixInput): HeatMatrixModel;
export interface RingGaugeInput { value: number | null; max: number; label: string; format(value: number): string; secondary?: string }
export interface RingGaugeModel { arcs: readonly RingArc[]; figure: string; label: string; secondary: string | null; spoken: string }
export function ringGaugeModel(input: RingGaugeInput, geometry: RingGeometry): RingGaugeModel;
// apps/mobile/src/widgets/heat-matrix.tsx, ring-gauge.tsx (lane d): HeatMatrix({ model, height }), RingGauge({ model, size })

// apps/mobile/src/widgets/stream-area.tsx (lane e): StreamArea gains `variant?: "chart" | "spark"` (default "chart")
// apps/mobile/src/widgets/sparkbars.tsx (lane e)
export function Sparkbars(props: { data: MirrorBarsData; height: number; accessibilityLabel: string }): JSX.Element;
```

#### Lane a brief
- **Goal:** one set of navigation chrome and list primitives, so every screen in phase 11 reads as one app and no content draws under the status bar without a material behind it.
- **Interface:** `Icon`, `HeaderButton`, `BackButton`, `useAccessibilityEscape`, `screenOptions`, `ScreenScroll`, `GroupedList`, `ListSection`, `ListRow`, `SwipeRow`, `DemoBadge`, as in the scaffold contracts.
- **Behavior:**
  - Colors only through `useThemeColors()` (phase 7 lane a); no literal colors, no `themeColors[...]` lookups.
  - `screenOptions` returns the shared header config: `headerTransparent`, `headerBlurEffect: "systemChromeMaterial"`, `headerLargeTitleShadowVisible: false`, title weight `"600"` (RFC 3: weight 590 renders as `"600"`), `headerBackVisible: false` plus `headerLeft: () => <BackButton />` unless `root`. Native edge swipe-back stays on (`gestureEnabled: true`).
  - `ScreenScroll` sets `contentInsetAdjustmentBehavior="automatic"` and the screen background; with `headerShown={false}` it pads by the top safe-area inset and clips instead.
  - `Icon` renders `SymbolView` from `expo-symbols` with the theme tint; jest renders it through the module's own jest mock if it ships one, else a test helper in `test/ui/chrome/`.
  - `ListRow` is the grouped-list row for every settings page: min height 44 pt, title in `body`, subtitle in `caption`, value in `value` right-aligned, chevron or checkmark accessory, destructive rows in `--color-destructive` and never cyan.
  - `SwipeRow` uses Gesture Handler's `ReanimatedSwipeable`, a destructive trailing action, and the same action as an `accessibilityActions` entry.
  - `DemoBadge` is a chip-styled `Pressable` ("Demo", `label` variant in a bordered pill), opening `ActionSheetIOS.showActionSheetWithOptions` with "Exit demo" (`destructiveButtonIndex`) and "Cancel".
- **Decisions already made:** chevron-only back with no label and no glass fill, tinted `foreground`, in a 44 pt hit area, with `accessibilityLabel="Back"` and the escape gesture; native edge swipe-back stays; the host pager stays, so the chevron stays visible (the user, 2026-11-25). Header buttons are 28 pt stroke icons with no glass fill. Scroll-edge material through the native blur, not a custom view (RFC 4.1, item 22). Icons come from SF Symbols through `expo-symbols`, replacing three chevron paths and the inline gear (architecture M3).
- **Out of scope:** adopting the primitives in screens (phase 11), the reorder list (lane b), text (scaffold).
- **Done when:** the table's Done-when conditions are met.

#### Lane b brief
- **Goal:** the drag-reorder, segmented control and sheet primitives the card stack, Settings > Hosts and the range control use.
- **Interface:** `ReorderList`, `SegmentedControl`, `Sheet`.
- **Behavior:**
  - `ReorderList` wraps `react-native-reorderable-list` (`ReorderableList`, or `NestedReorderableList` when `nested`), with `onDragStart` firing `Haptics.impactAsync(Medium)` and `onDragEnd` `Haptics.impactAsync(Light)`. Release-without-move is detected from the drag events (start and end at the same index with no `onReorder`) and calls `onReleaseWithoutMove`. Each item carries `accessibilityActions` "Move up"/"Move down" (omitted at the ends) built from `itemLabel`.
  - `SegmentedControl`: a compact track (no heavy border box, audit item 19) with a Reanimated thumb; duration from the motion tokens (`ui/motion.tsx`), 0 under Reduce Motion or Low Power Mode.
  - `Sheet`: React Native `Modal` with `presentationStyle="pageSheet"`, a `title` header and Done.
  - If the scaffold reported the library doesn't fit, this lane is replaced by the L fallback lane named in the scaffold report.
- **Decisions already made:** `react-native-reorderable-list` over a hand-written list (maintained, on Reanimated and Gesture Handler, has a nested variant); haptics from `expo-haptics`; one primitive for the card stack and Settings > Hosts (RFC 4.5, 4.7, 5).
- **Out of scope:** the card action menu (phase 11 lane c1 uses `ActionSheetIOS` on `onReleaseWithoutMove`), persistence of orders (the callers).
- **Done when:** the table's Done-when conditions are met.

#### Lane c brief
- **Goal:** labelled value and time ticks, and the module hero specs, available to both apps from core.
- **Interface:** `valueTicks`, `timeTicks`, the moved `module-hero.ts`.
- **Behavior:**
  - `valueTicks` follows the design-system Y-scale rule: a fixed domain's ceiling or a `niceCeiling` passed in; labels through the caller's formatter.
  - `timeTicks` uses `@core/host-clock` for host time and `@core/time-grid` steps; label width is estimated with `CHART_CAPTION_CHAR_WIDTH_PX` times `captionScale`, as the annotation model does, so the same rule works at AX sizes.
  - `module-hero.ts` moves to core with its test, unchanged; `src/app/components/module-hero.ts` becomes `export * from "@core/module-hero"`. It has no React or desktop import today; if one appears, the lane stops and reports.
- **Decisions already made:** the ticks are a shared model the desktop adopts later (RFC 5); the move happens now because the phone is the second consumer (README guard 1).
- **Out of scope:** desktop adoption of the ticks, any chart renderer.
- **Done when:** the table's Done-when conditions are met.

#### Lane d brief
- **Goal:** the Power & Sensors rings and the thermal and per-core heat matrices are decided once in core and rendered by both apps.
- **Interface:** `heatMatrixModel`, `ringGaugeModel`, the phone `HeatMatrix` and `RingGauge`.
- **Behavior:**
  - Follow the `widget-model` skill, one widget per commit: extract the label, legend, current-value, spoken-text and cell logic from the desktop components into the models, over the existing `heatmapAlpha` and `ringArcs`. The desktop components render the models and keep their layout, motion and DOM.
  - The models take measurable inputs (values, domain, formatter, geometry), never a platform flag. Temperature unit is a formatter input (`formatTemperature(v, { units })`), so the phone's locale unit in phase 12 needs no model change.
  - The phone twins draw with `react-native-svg`, colors from the ramp tokens, gaps as gaps.
- **Decisions already made:** shared widget models, tested once and rendered twice (`packages/core/README.md`); rings and the SoC heatmap port to the phone (the user's Power & Sensors decision).
- **Out of scope:** the Power & Sensors and CPU pages (phase 12), the desktop's `core-heatmap.tsx` and `ring-stat-card.tsx` (unchanged; they compose the changed components).
- **Done when:** the table's Done-when conditions are met, with `make e2e-perf` before and after reported.

#### Lane e brief
- **Goal:** the sparklines the hosts-list rows need, and the CPU and Network card charts drawn the popover's way.
- **Interface:** `StreamArea` `variant`, `Sparkbars`, `MirrorBars` (existing props).
- **Behavior:**
  - `variant="spark"`: no time axis, line plus area at the module accent, the ceiling label in the `axis` variant at the top-left corner on the top gridline, sized for a 36 pt plot.
  - `variant="chart"` (default): the ceiling label moves onto the top gridline (audit item 8). Height stays the caller's.
  - `Sparkbars` and `MirrorBars` draw download at ramp step 1 below the axis and upload at ramp step 2 above, from `mirrorBarsModel`; `MirrorBars` shows "↓ Download" and "↑ Upload" labels from its data (item 12).
  - A model option only the phone needs is a fork listed under "Forks" in `packages/core/README.md` (RFC 5).
- **Decisions already made:** sparklines are phone twins of the existing `streamAreaModel`/`mirrorBarsModel` (RFC 5); ramp steps 1 and 2 per `plan/design-system.md`.
- **Out of scope:** the row layout and its data (phase 11 lane d), card layout (phase 11 lane c2).
- **Done when:** the table's Done-when conditions are met.

### Phase 11: surfaces

Demo:
- **Simulator, demo hosts, light, dark and AX1:** the welcome screen shows a live labelled "Example host" preview of the CPU, Memory and Network cards ticking at 1 Hz, one sentence, "Add a host" and "Try demo hosts". "Try demo hosts" lands on Hosts, where each row shows the name, OS glyph, status and three accent charts (CPU, memory, network) with distinct values per host; the offline host shows dashes and "Offline since HH:MM". The "Demo" chip opens "Exit demo", which returns to welcome.
- **Host screen:** the host name is the large title and collapses on scroll, with the chevron-only back; scrolled cards pass under the status bar with the chrome material behind them. CPU, Memory, GPU and Network fit one iPhone 18 Pro screen; the chevron toggles density, a body tap opens the module, long-press-and-move reorders with haptics, long-press-and-release opens the action sheet.
- **Module page (generic per module):** a 5m/1h/More segmented control, a stat strip with avg and peak from the history answer, a ticked chart with hatched gaps and pill annotations, scrubbing with a pinned readout, the live process table (on a host that sends processes) and the module's own events. The Network page shows no power event.
- **Settings:** Hosts is one grouped list; a row opens the host detail page; swipe-to-delete asks before removing; press-hold-and-drag reorders. Appearance has checkmarks. The settings back control matches the host screen's.
- **Pairing:** each step (priming, denied, unavailable, paste, preview with and without `can_hand_over`, waiting, success, failure) in the shared layout with actions above the home indicator; the setup guidance sits before scanning. `update-from-mac` and `pair-hosts` use the shared header.

Depends on: phase 9, phase 10

Code facts this phase relies on (checked 2026-11-25; the state after phases 7 to 10 land, naming the contract each relies on):
- **Headers.** `(hosts)/_layout.tsx` sets `headerLargeTitle: true` for every screen and `title: ""` on `[host]/index` (audit item 1); `HostScreen` then draws its own title in content. After phase 7 lane a the colors come from the navigator theme; after phase 10 lane a `screenOptions(colors)` and `BackButton` exist but no layout uses them.
- **Settings is a nested stack with a hand-drawn back.** `app/_layout.tsx` mounts `settings` with `headerShown: false`, so `settings/index.tsx` draws its own chevron (architecture I6). `settings/_layout.tsx` declares six screens. Phase 10's scaffold moved `host-settings.tsx` to `apps/mobile/src/settings/`; it renders every host as a card with a cyan Rename, arrows and a cyan Remove, and the "Update from Mac" row phase 8 lane c added.
- **Phase 9's screens set their own headers.** `update-from-mac.tsx` and `pair-hosts.tsx` (phase 9 lane c) set their own `Stack.Screen` options and still use `role` on `Text` (phase 10's alias).
- **The demo lives by route names.** `DemoLifetime` in `data/demo.ts` keeps the demo transport while a route named `"demo"` or `"(hosts)"` is on the stack (architecture M8). `test/first-launch.test.tsx` spies on `setInterval`/`clearInterval` (tests M4).
- **Welcome and pairing.** After phase 8 lane c, `app/index.tsx` is a placeholder welcome with "Add a host" and "Try demo hosts", and it imports `ActionButton` from `src/components/` (architecture I9; the only other importer, `pair-linux.tsx`, was deleted in phase 8). The pairing views are in `pairing/screens/` (`choose-method`, `scanner`, `paste`, `preview`, `waiting`, `result`), the logic in `pairing/flow.ts` (phase 8 lane c) and `after-pair.ts` (phase 9 lane c). `PairingState { hosts, key_changed }` is a `PhoneTransport` call (phase 8 scaffold).
- **The card stack rebuilds every tick.** `host/host-page.tsx` subscribes to six selections and two streams in one component and runs `buildCardStack` each render (architecture I5); card dimming uses React Native `Animated` (M14). `host/card-menu.tsx` is a `Modal` with "Move up"/"Move down". `test/host/host-screen.test.tsx` spies on component exports for render counts (tests M2) and on `Animated.timing` (L2), and its first test covers seven behaviors (L4). Card content comes from `packages/core/src/popover/cards/` (phase 7 lane g, `CardContent`).
- **Chart wording is written twice.** `data/live-stream.ts` builds "CPU, last 60 seconds, now 18%" itself and holds figures on `performance.now()`; the desktop's `src/app/hooks/use-chart-label.ts` adds a trailing period and holds per 10 s bucket of the stream edge (architecture I4).
- **Connection wording** is `phoneProblem` and `hostStatusSummary` in `packages/core/src/phone-connection.ts` (phase 7 lane f); the banner is in `apps/mobile/src/connection/`. The pill reads `status.demand` (phase 8 lane d: `compact` when `live_allowed` is false) but has no wording for it yet.
- **Hosts list.** Rows (`hosts/host-row.tsx`) show one CPU sparkline pinned to the floor and values that aren't accent-tied (items 15, 16). The row data is one `useHostHistory` query for `cpu.total`, `mem.used`, `net.rx_total`, `net.tx_total` over 30 minutes (phase 7 lane k) with each `HostSummary` appended (phase 8 lane d, `useFocusDemand(host, "compact")`). `test/hosts/hosts-list.test.tsx` spies on `StreamArea` (tests M1).
- **Demo data.** Every demo host reports the same vitals from `packages/core/src/mock/remote.ts`; `mock/history.ts`'s `mockGaps` always cuts past nights and, with `sleep-gap`, an hour gap; `mock/host-history.ts` (phase 7 lane k) answers `hostHistory` from the same generator for every host. Desktop tests read the default mock.
- **Module page.** `module/index.tsx` is one 153-line screen with one 0-100 % chart, a custom bordered `RangeControl` over `PHONE_RANGES` (`data/history.ts`), `ScrubbableChart`, and `EventsList`. Phase 7 lane k's hooks (`useModuleHistory`, `useEvents`, `useHostHistory`) read one `hostHistory` answer that carries `stats` and the module's events, filtered on the host by `EventDetail::module()` (phase 7 lane j1). A failed status read shows only the error line (errors L3). `test/module/module-screen.test.tsx` sets an unused `latencyMs` (tests L6).
- **Annotations already have a shared layout model.** `packages/core/src/widget-models/chart-annotation.ts` `annotationsModel` places markers in rows through `layoutMarkers` and merges collisions into "+N"; the desktop's `src/app/widgets/chart-annotation.tsx` uses it. The phone's `widgets/chart-annotations.tsx` draws the `marker` variant at `top: 12` inside the plot, so labels sit over the series (audit item 23).
- **Process interest.** `useProcessDemand(host, view)` in `data/processes.ts` sets and clears `MobileCall::SetProcessInterest` on focus and blur (phase 8 lane d). `ProcessInterest`, `FULL_TABLE`, `unionViews` (`@core/process-interest`) and `groupLiveProcesses` (`@core/process-groups`) are the desktop's.
- **Titles.** `HISTORY_MODULES` (`data/history.ts`) names the power module "Power".

Test cases:

**Navigation and settings (lane a)**
- Headers (`test/navigation/`):
  - The hosts list keeps the large title "Hosts"; the host screen's large title is the host name (set by the host screen), with no in-content title; module pages use a standard title.
  - Every pushed screen (host, module, settings pages, host detail, pairing, `update-from-mac`, `pair-hosts`, debug) renders `BackButton` and sets `headerBlurEffect: "systemChromeMaterial"` through `screenOptions`; a grep test finds no `headerTintColor`, `headerBackTitle` or hand-drawn chevron outside `ui/`.
  - The hosts list's header has the settings `HeaderButton` and, in demo mode, the `DemoBadge`; "Exit demo" calls `useDemo().exit()`.
  - The `/dev/primitives` route is gone.
- Settings presentation: `settings/_layout.tsx` is deleted and the settings screens join the root stack, so every settings page gets the native back gesture and `BackButton`; `settings/index.tsx` draws no chevron (architecture I6).
- Settings > Hosts:
  - One grouped list; each row shows the OS glyph, name and the `hostStatusSummary` subtitle and opens `/settings/host/<id>`.
  - Swipe-to-delete opens an action sheet whose "Remove <host>" is destructive and says this iPhone stops monitoring the host, whose history stays on the host; confirming calls `removeHost` and drops the row; Cancel leaves the host and makes no call.
  - Drag reorder persists `hostOrder` across a relaunch (the phase 8 persistence adapter); VoiceOver "Move up"/"Move down" reorder.
- Host detail (`settings/host/[host]`): Rename is an inline field that saves on submit; Routes are read-only rows; Re-pair pushes `/pair`; "Update from Mac" pushes `/update-from-mac`; Remove is a destructive full-width row at the bottom with the same confirmation.
- This iPhone: the key line in a monospace caption with Copy; App Lock as a switch row. Data: one switch, "Live updates on cellular", with the footer "When this is off, the host screen updates every 5 s on cellular." Appearance: three checkmark rows (System, Light, Dark), no link-colored text. About: label/value rows with values right-aligned in `value`, and the licenses link.
- Tests audit L1 and L4: `about.test.tsx` keeps the no-build-info case and `transport.test.ts`'s duplicate is not this lane's (left); `settings.test.tsx` is split per page; the Appearance round trip in `test/data/seam.test.tsx` is deleted here as the duplicate of the settings test (the lane owns that file for the deletion only).

**Front door (lane b)**
- Welcome:
  - Renders the live preview (`CpuCard`, `MemoryCard`, `NetworkCard` on a mock transport's live fixture) labelled "Example host" with one VoiceOver label, one sentence, "Add a host" (primary, pushes `/pair`) and "Try demo hosts" (secondary, starts the demo).
  - The preview ticks only while the welcome screen is focused: after blur, advancing fake time 5 s delivers no frame (the transport has no subscriber), and focus resumes it. Under Reduce Motion or Low Power Mode it shows one still frame.
  - The title uses `onboardingTitle`; there is no weight 700 and no raw `react-native` `Text` (architecture I9).
- States: first launch shows welcome; "Exit demo" returns to welcome and clears the demo transport; `pairingState` with `key_changed: true` shows the restore notice ("This iPhone needs to pair again…") with "Pair again", which pushes `/pair`.
- Demo lifetime (architecture M8): `DemoProvider` starts and ends the demo through `useDemo().start(scenario?)` and `exit()`; renaming a route doesn't end it (a test navigates through a renamed test route and the demo stays). `test/first-launch.test.tsx` asserts outcomes, not timer ids (tests M4).
- Pairing presentation: each step renders the shared step layout (title, explanation, content, actions pinned above the home indicator); the choose-method step shows the four setup steps, "Host doesn't have StatGlass yet?" with the copyable releases URL and the Linux line, and "What the phone can see"; failures render the `PhoneProblem` tone and wording; the preview shows "Can also add the hosts it monitors" only with `can_hand_over`. `pairing/flow.ts` tests stay green unchanged.
- `src/components/` is deleted.

**Host screen (lane c1)**
- The host name is set as the native large title; no in-content title; content is in `ScreenScroll`.
- Gestures, one test each:
  - tapping the card header chevron toggles compact or expanded with a light haptic, and the density persists across a remount (`compact[card]`);
  - tapping the card body pushes the module page;
  - long-press then move reorders the stack and persists `cardOrder` for every host;
  - long-press released without moving opens `ActionSheetIOS` with "Compact"/"Expand", "Open <module title>" and "Move to top", and each acts;
  - VoiceOver custom actions "Toggle compact", "Move up", "Move down" and "Open" act.
- `card-menu.tsx` and its Modal are gone.
- Rendering cost: a `Profiler` per card counts commits; a frame that changes only CPU re-renders only the CPU card (revert-verified by widening a selector). The export spies go (tests M2).
- Dimming: a stale host dims cards to 50 % through Reanimated; under Reduce Motion the opacity is 0.5 at once. The `Animated.timing` spy test is deleted (tests L2).
- `host-screen.test.tsx`'s first test is split into paging and URL, blur and back, and unmount (tests L4); the expected `[live]` error and warning and the router warning are asserted with spies (tests L10).
- The pill says "Every 5 s on cellular" when the status carries `demand: compact`, from `hostStatusSummary`; a core test covers it.
- The connection banner (phase 7 lane f) uses the grouped-list surface and `HeaderButton`-style action; its wording is unchanged (`test/connection/` passes with no copy edits).

**Cards (lane c2)**
- Card header: an 8 pt accent swatch, the `cardTitle`, the `cardFigure` value, and the density chevron as the only header control (44 pt hit area).
- CPU: a 52 pt chart with the ceiling label on the top gridline. Memory: "Pressure · normal|warn|critical" and a one-column legend with a swatch for every segment (Swap hatched). Power: unreported components omitted; with none, a compact unavailable row; "Power & battery" shows the battery inline. Unavailable modules: one compact line with title and reason, in `popoverSlots` order. Network: the `MirrorBars` with ramp steps and "↓ Download"/"↑ Upload" labels.
- Chart accessible names come from core `chartLabel` (architecture I4): the phone and the desktop produce the same string for the same input, with the desktop's trailing period and its per-bucket hold rule; `src/app/hooks/use-chart-label.test.tsx` passes unchanged.
- Desktop: `bun run test -- packages/core/src/popover src/app/routes/popover src/app/hooks`, the gallery and the render-count e2e pass unchanged.

**Hosts list and demo data (lane d)**
- Row: name, OS glyph, `hostStatusSummary` status on the top line; three equal columns, each a `cardFigure` in the accent's ink over a 36 pt chart: CPU spark (cyan), memory spark (violet, % of `mem_total_bytes`), network `Sparkbars` (green).
- Scale: CPU and memory ceilings are `niceCeiling` of the 30-minute maximum with floors 10 % and 25 %, labelled; a 5-25 % CPU series draws under a 30 % ceiling.
- A null bucket is a gap. A stale row dims to 50 %. An offline row shows dashes, no chart and "Offline since HH:MM" in host time (exact string). With `key_changed`, every row's status reads "Needs pairing".
- Assertions read accessible names and values ("CPU history over the last 30 minutes, peak 24%"), not `StreamArea` props (tests M1).
- No `subscribeLive` call from the list (the mock records it).
- Demo data: each demo host's vitals and history are seeded from its id, so two hosts' values differ; with no scenario, a live demo host's chart has no gap where the live window joins history; only `sleep-gap` shows one. Desktop tests that read the default mock pass unchanged.
- Empty: when the native host list becomes empty (last host removed), the list replaces to `/`.

**Module frame (lane e)**
- Frame: native title with the hardware subtitle (`headerTitle` with a caption line); `SegmentedControl` with 5m, 1h and More; More opens a `Sheet` of `RANGE_PRESETS` the host keeps, and choosing one closes it and asks the host again (one new `hostHistory` call).
- Stat strip: a `heroFigure` lead, labelled items from the module's hero spec (`@core/module-hero`), and Avg and Peak from the answer's `stats`; a missing value shows `MISSING`, never 0.
- `ModuleChart`: value ticks (`valueTicks`) and time ticks (`timeTicks`) labelled, ramp series, hatched gaps; scrubbing shows a crosshair and a host-time readout of every series; a long press pins the readout with a haptic; VoiceOver gets an adjustable element stepping through buckets.
- Annotations: pills in a band above the plot area from `annotationsModel(..., variant "pill")`; two colliding events form a second row or a "+N" pill; no label is drawn inside the plot.
- Events: the list and the annotations use the same module-filtered list; the Network page on a fixture holding an ANE `power_spike` shows no event.
- `LiveProcessTable`: at most 10 rows from `groupLiveProcesses`, sorted by the page's sort; interest set on focus and cleared on blur (the mock records `setProcessInterest(true)` then `false`); a host that sends no processes shows "Processes are not available from this host".
- Errors: a failed status read shows the module's error state with Retry, not a blank page (errors L3); `RemoteUnsupported` and `RemoteBusy` render phase 7 lane k's states in the chart area.
- `HISTORY_MODULES.power.title` is "Power & Sensors".
- `module-screen.test.tsx` drops the unused `latencyMs` (tests L6).

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | apps/mobile/src/app/_layout.tsx, apps/mobile/src/app/(hosts)/_layout.tsx, apps/mobile/src/app/(hosts)/index.tsx, apps/mobile/src/app/settings/, apps/mobile/src/app/update-from-mac.tsx, apps/mobile/src/app/pair-hosts.tsx, apps/mobile/src/app/debug.tsx, apps/mobile/src/app/dev/, apps/mobile/src/settings/, apps/mobile/src/lock/app-lock-setting.tsx, apps/mobile/test/settings/, apps/mobile/test/navigation/, apps/mobile/test/data/seam.test.tsx | contracts, RFC 4.1, 4.7; audit-architecture I6, M4; audit-tests L1, L4; design audit items 1-3, 17, 21, 22 and the settings sub-page notes | headers on every pushed screen, settings in the root stack, Hosts list, swipe-delete confirm and cancel, reorder persistence, host detail actions, Appearance checkmarks | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/settings test/navigation test/data`, `make mobile-check`; simulator screenshots of each settings page, host detail, `update-from-mac` and `pair-hosts` in light, dark and AX1, compared with the dashboard settings page |
| b | L | apps/mobile/src/app/index.tsx, apps/mobile/src/app/demo.tsx, apps/mobile/src/app/pair.tsx, apps/mobile/src/welcome/, apps/mobile/src/pairing/screens/, apps/mobile/src/pairing/help/, apps/mobile/src/data/demo.ts, apps/mobile/src/components/, apps/mobile/test/welcome/, apps/mobile/test/pairing/, apps/mobile/test/first-launch.test.tsx | contracts, RFC 4.2, 4.3; audit-architecture I9, M8; audit-tests M4; design audit item 20; `apps/mobile/src/pairing/flow.ts` | welcome states, preview ticks only while focused, demo lifetime, restore notice, every pairing step | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/welcome test/pairing test/first-launch.test.tsx`, `make mobile-check`; simulator screenshots of welcome (iPhone SE and 18 Pro at the default size, AX1 scrolled) and every pairing step in light and dark, compared with the desktop onboarding and "Pair iPhone" sheet |
| c1 | L | apps/mobile/src/host/, apps/mobile/src/connection/, packages/core/src/phone-connection.ts, packages/core/src/phone-connection.test.ts, apps/mobile/test/host/, apps/mobile/test/connection/ | contracts, RFC 4.0, 4.5; audit-architecture I5, M14; audit-tests M2, L2, L4, L10 | card gestures one test each, Profiler counts, Reanimated dimming, cellular pill wording, banner restyle | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/phone-connection.test.ts`, `bun run --cwd apps/mobile test -- test/host test/connection`, `make mobile-check`; simulator recording of reorder and the release menu; screenshots of the host screen at rest and scrolled under the status bar in light, dark and AX1 next to the popover |
| c2 | L | apps/mobile/src/cards/, apps/mobile/src/widgets/stat-list.tsx, apps/mobile/src/widgets/meter-track.tsx, apps/mobile/src/data/live-stream.ts, packages/core/src/popover/cards/, packages/core/src/chart-label.ts, packages/core/src/chart-label.test.ts, src/app/hooks/use-chart-label.ts, apps/mobile/test/cards/ | contracts, RFC 4.5; audit-architecture I4; design audit items 5-12; `src/app/routes/popover/_components/popover-cards.tsx` | card anatomy, CPU, memory, power, unavailable and network cards, one chart wording for both apps | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/popover packages/core/src/chart-label.test.ts src/app/routes/popover src/app/hooks`, gallery and render-count e2e, `make e2e-perf` (before and after), `bun run --cwd apps/mobile test -- test/cards`, `make mobile-check`; card screenshots in light, dark and AX1 next to the popover, desktop popover screenshots unchanged |
| d | M | apps/mobile/src/hosts/, apps/mobile/src/data/hosts.ts, apps/mobile/src/data/hosts-list.ts, packages/core/src/mock/remote.ts, packages/core/src/mock/history.ts, packages/core/src/mock/host-history.ts, packages/core/src/mock/host-history.test.ts, packages/core/src/mock/demo-hosts.test.ts, apps/mobile/test/hosts/ | contracts, RFC 4.4, 4.8; audit-tests M1; design audit items 13-16 | three columns and accents, autoscaled ceilings, gaps, stale and offline, Needs pairing, per-host demo values, no live gap, empty to welcome | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/mock`, `bun run test` (desktop, unchanged), `bun run --cwd apps/mobile test -- test/hosts`, `make mobile-check`; hosts-list screenshots with live, stale and offline demo hosts in light, dark and AX1 next to the popover cards |
| e | L | apps/mobile/src/module/, apps/mobile/src/data/history.ts, apps/mobile/src/data/processes.ts, apps/mobile/src/widgets/chart-annotations.tsx, apps/mobile/test/module/, apps/mobile/test/data/host-history.test.tsx | contracts, RFC 4.6, 4.8; audit-errors L3; audit-tests L6; design audit items 18, 19, 23; `src/app/components/module-page.tsx` | range control and More sheet, stat strip from `stats`, ticks, scrub and pin, pill annotations, process table and interest, module error state | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/module test/data`, `make mobile-check`; simulator screenshots of each module's generic page at 1 h and 7 d in light, dark and AX1 next to `/dashboard/<module>` |

Ownership:
- **The RFC's lane c is split in two (c1, c2).** As one lane it owned the host screen, its gestures and tests, every card, the shared card models and the chart wording, an XL job. c1 owns the host screen and the connection surfaces; c2 owns the card visuals and their content. They meet at `ModuleCardProps` (scaffold): c2's cards stay render-only (`src/cards/**` may not import `@/data` or the router, phase 7 lane b's rule) and take `compact`, `onToggleDensity` and `onOpen`; c1 wraps them in `ReorderList` and owns the gestures around them.
- **Lane a owns route headers; content lanes own titles.** The host screen sets its own title (c1) and the module page its title and subtitle (e) through `<Stack.Screen options>`; lane a owns the layouts, `(hosts)/index.tsx` and the root stack's options for `pair`, `demo`, `debug`, `update-from-mac` and `pair-hosts`. Lane a edits phase 9's two route files for header options only.
- **The demo provider is lane b's, mounted by the scaffold.** The scaffold replaces `<DemoLifetime />` in `_layout.tsx` with `<DemoProvider>` (stub in `data/demo.ts`), so lane a's root layout and lane b's provider don't wait on each other. Lane a's `DemoBadge` calls `useDemo().exit()`.
- **The restore notice is lane b's, mounted by the scaffold** in the hosts list's header slot (`hosts/hosts-list.tsx` renders `<RestoreNotice />` from `@/welcome/restore-notice`, a stub); lane d renders "Needs pairing" on the rows.
- **Lane d owns the demo mocks.** Lane e's tests use `mock/host-history.ts` as it is at phase start and assert relative to the mock's own output, so lane d's per-host seeding doesn't break them; lane e rebases on d before its final run if a value assertion moves.
- **The data hooks keep phase 8 lane d's demand calls.** `data/hosts.ts` (d), `history.ts` and `processes.ts` (e) keep `useFocusDemand` and `useProcessDemand`.
- **Lane c2 is the only lane touching desktop code** (`use-chart-label.ts`, the popover card models). The desktop's tests, gallery and render counts pass unchanged and `make e2e-perf` is reported before and after.
- **Lane a takes `test/data/seam.test.tsx`** only to delete the duplicate Appearance round trip (tests L1).

#### Scaffold contracts (phase 11)

Inline before dispatch, after phase 9 and phase 10 have merged:
- **Finish the `variant` rename.** Rename `role` in phase 9's files (`update-from-mac.tsx`, `pair-hosts.tsx`, `apps/mobile/src/handover/`), delete the `role` alias from `TextProps`, and extend the text grep test to fail on `role=` for `Text`.
- **Demo provider.** Replace `<DemoLifetime />` with `<DemoProvider>` around the root stack in `app/_layout.tsx`; stub `DemoProvider` and `useDemo` in `data/demo.ts` over today's behavior.
- **Restore notice.** Stub `apps/mobile/src/welcome/restore-notice.tsx` and render it from `hosts/hosts-list.tsx`'s header.
- **Card props.** Write `ModuleCardProps` into `apps/mobile/src/cards/types.ts` and pass the new props from `host/card-stack.ts` with today's behavior.
- **Module pages.** Create `apps/mobile/src/module/pages/index.ts` mapping each `PopoverCard` to the generic page, and `module/pages/generic.tsx` wrapping today's `ModuleHistory`.
- **Chart label.** Stub `packages/core/src/chart-label.ts`.
- Then `bun run typecheck`, `make mobile-check`, `bun run test`.

```ts
// apps/mobile/src/data/demo.ts (lane b)
export function DemoProvider(props: { children: ReactNode }): JSX.Element;
export function useDemo(): { active: boolean; start(scenario?: string): void; exit(): void };
// apps/mobile/src/welcome/restore-notice.tsx (lane b): renders nothing unless pairingState().key_changed
export function RestoreNotice(): JSX.Element | null;
// apps/mobile/src/welcome/welcome-screen.tsx (lane b)
export function WelcomeScreen(): JSX.Element;
export function ExamplePreview(props: { focused: boolean }): JSX.Element; // its own mock transport, live fixture

// apps/mobile/src/cards/types.ts (lane c2 renders, lane c1 passes)
export interface ModuleCardProps {
  card: PopoverCard; content: CardContent; compact: boolean;
  onToggleDensity(): void; onOpen(): void; stale: boolean;
}
// packages/core/src/chart-label.ts (lane c2), the desktop's wording and hold rule
export function chartLabel(input: { subject: string; spanMs: number; now: string | null; brushable?: boolean }): string;
export function shouldRefreshFigures(prev: { bucketMs: number; edgeMs: number } | null, next: { bucketMs: number; edgeMs: number }): boolean;
// packages/core/src/phone-connection.ts (lane c1): hostStatusSummary's label covers demand "compact" ("Every 5 s on cellular")

// apps/mobile/src/module/pages/index.ts (scaffold; phase 12's scaffold rewires it)
export interface ModulePageProps { host: HostId; module: PopoverCard; range: HistoryRangeChoice; remote: RemoteHostStatus }
export const MODULE_PAGES: Record<PopoverCard, ComponentType<ModulePageProps>>;
// apps/mobile/src/module/ (lane e), the frame phase 12's pages compose
export function ModuleFrame(props: { title: string; subtitle: string | null; range: HistoryRangeChoice;
  onRange(r: HistoryRangeChoice): void; children: ReactNode }): JSX.Element;
export function StatStrip(props: { lead: StatItem; items: readonly StatItem[]; stats: readonly SeriesStatsInfo[] }): JSX.Element;
export function ModuleChart(props: { series: readonly ChartSeries[]; gaps: readonly Gap[]; ceiling: Ceiling;
  format(v: number): string; range: HistoryRange; events: readonly Event[]; clockOffsetMs: number; height: number }): JSX.Element;
export function LiveProcessTable(props: { host: HostId; sort: ProcessSort; view: ProcessView }): JSX.Element;
export function EventsList(props: { events: readonly Event[]; showDate: boolean }): JSX.Element;
// apps/mobile/src/data/processes.ts (lane e): useLiveProcesses(host, sort): { rows: LiveGroup[] | null; available: boolean }
```

#### Lane a brief
- **Goal:** every header and every settings page follows one iOS convention, and nothing draws under the status bar without a material.
- **Interface:** `screenOptions`, `BackButton`, `HeaderButton`, `DemoBadge`, `GroupedList`, `ListRow`, `SwipeRow`, `ReorderList` (phase 10), `useDemo().exit()` (scaffold).
- **Behavior:**
  - Root and hosts layouts use `screenOptions(colors)`; the hosts list sets `headerLargeTitle`, the host screen keeps `headerLargeTitle` with the title the screen sets, module pages set `headerLargeTitle: false`.
  - Settings joins the root stack: delete `settings/_layout.tsx`, declare the settings screens' titles in the root layout, push `/settings` normally. Chosen over a modal sheet because the host screen and settings sub-pages must share the same back chevron and edge swipe (the user's back decision), and a sheet's first page has a Done button instead.
  - Settings pages are thin routes that render screens from `apps/mobile/src/settings/` ("route reads params, renders the screen", the part of architecture M4 RFC section 9 assigns here).
  - Settings > Hosts: `ReorderList` of `SwipeRow`-wrapped `ListRow`s; swipe opens `ActionSheetIOS` with "Remove <host>" (destructive) and the message "This iPhone stops monitoring <host>. Its history stays on the host."; confirm calls `removeHost` then updates settings, as phase 8 lane c's code does today.
  - Host detail at `app/settings/host/[host].tsx`: Rename (inline `TextInput` saving to `hostNames`), Routes, Re-pair, "Update from Mac", Remove.
  - Delete `apps/mobile/src/app/dev/` (phase 10's primitives route).
- **Decisions already made:** chevron-only back, edge swipe kept (the user, 2026-11-25); Remove is destructive, never cyan, with swipe-delete, a confirmation, and drag reorder with haptics and VoiceOver moves (the user's Settings > Hosts decision); "Sync history on cellular" is gone (D-152).
- **Out of scope:** the hosts list content (lane d), the welcome and pairing views (lane b), titles set by screens (c1, e), phase 9's screen bodies.
- **Done when:** the table's Done-when conditions are met.

#### Lane b brief
- **Goal:** the welcome screen is the front door, and pairing reads as one designed flow.
- **Interface:** `WelcomeScreen`, `ExamplePreview`, `RestoreNotice`, `DemoProvider`, `useDemo`.
- **Behavior:**
  - Layout top to bottom: the live preview, one sentence ("StatGlass shows your Macs' and servers' CPU, memory, power and network, live, from this iPhone."), "Add a host" (primary), "Try demo hosts" (secondary). It fits an iPhone SE at the default size and scrolls at AX1 inside `ScreenScroll`.
  - The preview renders c2's real `CpuCard`, `MemoryCard` and `NetworkCard` on its own `createMockTransport()` live fixture, subscribed only while the screen is focused (`useIsFocused`), one VoiceOver label ("Example host: CPU 18%, memory 42%, network 1.4 MB/s down"), a still frame under the motion tokens' reduced state.
  - `DemoProvider` owns the demo transport: `start` swaps in the mock transport and replaces to `/(hosts)`; `exit` disposes it, restores the native transport (or none) and replaces to `/`. No route-name checks.
  - `app/index.tsx` renders `WelcomeScreen` once phase 8's launch logic finds no hosts.
  - `RestoreNotice`: the RFC 4.2 restore sentence and "Pair again".
  - Pairing views: one `PairingStep` layout in `pairing/screens/` (title, explanation, content, actions pinned above the home indicator); the setup guidance lives in `pairing/help/` and renders on the choose-method step and is reachable from Re-pair. "Host doesn't have StatGlass yet?" uses the Mac answer and, for Linux, "The Linux agent is installed from the Mac app (see the README's "Monitor a Linux host")" (RFC open question 1 is unanswered, so no Mac-less install is offered).
  - Delete `src/components/` and its last import.
- **Decisions already made:** the welcome screen is the front door with a live labelled preview, "Add a host" primary and "Try demo hosts" secondary, and first-run, demo-exit, restore and no-hosts states (the user, 2026-11-25); setup guidance on the pairing screen, before scanning (RFC 4.2); `flow.ts` logic stays phase 8's.
- **Out of scope:** pairing logic, `after-pair.ts` and the handover screens (phases 8 and 9), the hosts list's empty redirect (lane d).
- **Done when:** the table's Done-when conditions are met.

#### Lane c1 brief
- **Goal:** the host screen reads like the popover at phone scale and its cards respond to the four gestures the user chose.
- **Interface:** `ModuleCardProps` (scaffold), `ReorderList` with `onReleaseWithoutMove` (phase 10 lane b), `ScreenScroll`.
- **Behavior:**
  - `HostScreen` sets `<Stack.Screen options={{ title: name }}>` and drops its in-content title. The pager stays.
  - `CardStack` renders one container per card in `popoverSlots` order; each container selects its own slice with module-scope selectors and builds its `CardContent` (architecture I5). The parent keeps only order and density.
  - Gestures: chevron tap toggles `compact[card]` with `Haptics.impactAsync(Light)`; body tap pushes the module; `ReorderList` (`nested`) reorders and writes `cardOrder`; `onReleaseWithoutMove` opens `ActionSheetIOS` with Compact/Expand, "Open <HISTORY_MODULES[card].title>", "Move to top". VoiceOver custom actions on each card.
  - Dimming moves to Reanimated `useAnimatedStyle` over the motion tokens (M14).
  - Delete `host/card-menu.tsx`.
  - `hostStatusSummary` gains the compact-demand wording in core.
  - The `connection/` banner uses `GroupedList`'s surface and `Text` variants; copy unchanged.
- **Decisions already made:** the chevron toggles density, a body tap opens the module, long-press-move drags, long-press-release opens the menu, no pressure-based press (the user's card gestures decision); `ActionSheetIOS`, not a native context menu, unless phase 10's scaffold switched to zeego (RFC 4.5); one card order for all hosts.
- **Out of scope:** card visuals and content (c2), the module page (e).
- **Done when:** the table's Done-when conditions are met.

#### Lane c2 brief
- **Goal:** each card matches the popover's anatomy and density, and the chart wording is the desktop's.
- **Interface:** `ModuleCardProps`, `CardContent` (phase 7 lane g), `chartLabel`, `StreamArea`, `MirrorBars` (phase 10 lane e).
- **Behavior:**
  - `module-card.tsx` header: 8 pt swatch, `cardTitle`, `cardFigure` value right, density chevron (`Icon chevron.down`/`chevron.up`) in a 44 pt area; no module chevron.
  - Sizes per RFC 1.4's mapping (phase 10's variants); tighter gaps (12 pt padding, 8 pt gaps) so CPU, Memory, GPU and Network fit an iPhone 18 Pro at the default size.
  - Card content changes go in the shared models in `packages/core/src/popover/cards/` only when the popover already behaves that way (Power's omitted components, Memory's pressure line); a change the popover doesn't want is a phone fork listed in `packages/core/README.md` through the orchestrator.
  - `chartLabel` and `shouldRefreshFigures` are the desktop's current wording and hold rule moved to core; `use-chart-label.ts` and `data/live-stream.ts` call them; callers pass the ceiling format, replacing `live-stream.ts`'s hardcoded `%`.
- **Decisions already made:** card text from the shared models, so phone and popover say the same words (RFC 4.5); unavailable modules as one compact line in unchanged slot order; Network as mirrored bars on the card (the user's Network decision).
- **Out of scope:** gestures and the stack (c1), the welcome preview's layout (b renders these cards).
- **Done when:** the table's Done-when conditions are met.

#### Lane d brief
- **Goal:** hosts-list rows read as compact popover cards, honest about gaps, staleness and offline hosts, with demo hosts that differ.
- **Interface:** `useHostHistory` and the summary appends (phases 7 k, 8 d), `StreamArea variant="spark"`, `Sparkbars`, `hostStatusSummary`.
- **Behavior:**
  - Row layout per the Test cases; values in the accent's ink (`--color-cpu-ink` and so on), figures in `cardFigure`.
  - Ceilings: `niceCeiling(max(30-minute max, floor))` with floors 10 % (CPU) and 25 % (memory); network autoscales each direction.
  - Memory % comes from `mem.used / mem_total_bytes` per bucket in `data/hosts.ts`, a view transform (`data-boundary.md`).
  - The row reads `pairingState` and shows "Needs pairing" when `key_changed`.
  - When the native host list goes from non-empty to empty, `router.replace("/")`.
  - Demo: seed each host's vitals and history from a hash of its id (`mock/rng.ts`); find and remove the hole where the live window joins seeded history on a live demo host. Desktop-visible defaults stay as they are: if a desktop test reads a value that would change, give the phone's demo hosts their own seed path instead and say so.
  - Keep phase 8 lane d's `useFocusDemand(host, "compact")` and `useVisibleHosts` calls.
- **Decisions already made:** three accent charts tall enough to show normal variation, gaps as gaps, offline rows with dashes and "Offline since" rather than dimmed last values (no history behind them, D-152), demo data varying per host (the user's hosts-list decision); rows update every 5 s while the pill says Live.
- **Out of scope:** Settings > Hosts (lane a), the restore notice's view (lane b).
- **Done when:** the table's Done-when conditions are met.

#### Lane e brief
- **Goal:** one module-page frame every module uses, so phase 12 only fills in each module's sections.
- **Interface:** `ModuleFrame`, `StatStrip`, `ModuleChart`, `LiveProcessTable`, `EventsList`, `useLiveProcesses`, `MODULE_PAGES`' generic page (scaffold).
- **Behavior:**
  - Frame order: title with subtitle, range control, stat strip, charts, live process table, events (RFC 4.6).
  - Range: `SegmentedControl` with 5m, 1h and More; More opens a `Sheet` of `RANGE_PRESETS` within the host's retention. `PHONE_RANGES` follows.
  - Stat strip items from `@core/module-hero` specs and `@core/format`; Avg and Peak from the history answer's `stats` for the series key; no aggregation on the phone.
  - `ModuleChart` replaces `scrubbable-chart.tsx` and `history-chart.ts`: `valueTicks` and `timeTicks` (phase 10 lane c), ramp series, hatched gaps, scrub crosshair and readout in host time, long-press pin with `Haptics.impactAsync(Medium)`, an `adjustable` VoiceOver element.
  - Annotations: `annotationsModel` with `variant: "pill"`, drawn in a reserved band above the plot (`widgets/chart-annotations.tsx`), never over a series. The existing core model already stacks rows and merges "+N", so no core change; if the phone needs a different rule, fork it per the README.
  - `LiveProcessTable` calls `useProcessDemand(host, view)` while mounted and focused and renders at most 10 `groupLiveProcesses` rows, read-only.
  - The generic page shows the module's hero chart, stat strip, process table and events; phase 12 replaces it per module.
  - `HISTORY_MODULES.power.title` becomes "Power & Sensors".
- **Decisions already made:** visualization parity with no brush, attribution, selection, per-app range tables or drill-down; a live process table on every page sorted by the page's metric (the user's basic-monitor and process-table decisions); events filtered to the module at the source, annotations that never overlap (item 23); history from the host only (D-152).
- **Out of scope:** each module's sections (phase 12), the per-core heatmap query (phase 12 lane a).
- **Done when:** the table's Done-when conditions are met.

### Phase 12: module pages

Demo:
- **Simulator, demo hosts (a Mac and a Linux host), light, dark and AX1, each page next to `/dashboard/<module>`:**
  - CPU: "chip · N performance + M efficiency cores", the stat strip (Total, User, System, I/O wait and Steal where present, Idle, Load avg, Pressure stall, Avg, Peak), the user/system ramp chart, the per-core heatmap with P and E rows, processes by CPU.
  - GPU: utilization chart and strip, frequency ring, residency stack bar, power chart, processes by GPU.
  - Memory: the composition stack bar and strip, the pressure chart on the Mac and Used/Cached on Linux, the swap card, processes by memory.
  - Network: "en0 · 143 Mb/s link · 192.168.86.242 · Public 76.143.14.53", the strip, mirrored history bars with labelled ceilings both ways, the interfaces list, processes by rate. A host whose public IP lookup is cold shows "Public …" then the IP.
  - Power & Sensors: four rings, the strip, the ticked power chart with its legend and notes, the SoC thermal zones heatmap in °C with an en-GB locale and °F with en-US, the battery day card, processes by energy.
  - Battery: rings for Charge, Health and Cycles, and Power, the battery day chart, processes by energy.
- **Docker host:** the Network page header shows the container's interface and addresses from `NetworkAddresses` (phase 7 lane h).

Depends on: phase 11

Code facts this phase relies on (checked 2026-11-25; the state after phases 7 to 11 land):
- **Pages.** After phase 11, `apps/mobile/src/module/pages/index.ts` maps every module to the generic page, over phase 11 lane e's `ModuleFrame`, `StatStrip`, `ModuleChart`, `LiveProcessTable` and `EventsList`.
- **Data.** `useHostHistory(host, selection, range, width)` (phase 7 lane k) issues one `hostHistory` query per chart key with the width budget; a heatmap passes its column count, and a request of only `cpu.load{core=*}` selectors gets the host's 256-series clamp (phase 7 lanes j1 and k). The answer carries per-key `stats` and module-filtered events.
- **Addresses.** `PhoneTransport.networkAddresses(host)` returns `HostAddressesInfo` with `public_ip.state` `known | pending | unavailable | unknown`; a host without `query.addresses.v1` returns `RemoteUnsupported`; the mock serves fixed addresses for demo hosts and `unavailable` for the Linux demo host (phase 7 lane h).
- **Desktop sources the pages port.** CPU: `src/app/routes/dashboard/cpu/` (`total-card.tsx`, `core-load-card.tsx`) and `_lib/clusters.ts` (`clusterViews`, `coreCounts`, with a test). GPU: `gpu/_components/{usage,frequency,power}-card.tsx`. Memory: `memory/_components/{composition,pressure,swap,used}-card.tsx`. Network: `network/route.tsx` over `LiveMirrorChart`, `RangeTotalsStrip`, `InterfaceTable` and `_lib/network.ts` (`interfaceRows`, `ofLink`, `networkSubtitle`), plus `AddressLine`. Power: `power/_components/{ring-cards,power-draw-card,zones-card}.tsx` and `BatteryDayCard`. Hero specs are in `@core/module-hero` (phase 10 lane c).
- **Heat and ring models** are `@core/widget-models/heat-matrix` and `ring-gauge`, with phone twins (phase 10 lane d).
- **Temperature.** Core formats °C or °F from `TemperatureUnits` (`format/temperature.ts`); the desktop reads its unit from its settings (`units.temperature`). The phone has no setting. `expo-localization` is installed (phase 10 scaffold); `getLocales()[0].temperatureUnit` is `"celsius"` or `"fahrenheit"`.
- **Power notes.** `@core/cpu-power-source` explains what "CPU power" measures ("CPU power: P cores").

Test cases:

**CPU and GPU (lane a)**
- CPU page, Mac and Linux fixtures: the header subtitle from `coreCounts`; each stat strip item equals `@core/format` of the selector or the answer's `stats`; Steal and I/O wait only where the host reports them; the total chart has user and system ramp series; the per-core heatmap renders P and E rows on the Mac and one row group on Linux, from its own `hostHistory` query with the heatmap's column count as the budget (the mock records two calls: the page's and the heatmap's); a 64-core fixture draws 64 rows.
- GPU page: utilization chart and strip items (Utilization, Renderer, Tiler, Frequency, Power, Avg, Peak); frequency ring from `ringGaugeModel`; residency stack bar; power chart; a host with no GPU shows the module's unavailable state.
- Processes: CPU sorts by CPU %, GPU by GPU with `gpu: true` in the view.
- No `UsageAppsCard` text or "Every process" link on either page.
- `packages/core/src/cpu-clusters.test.ts` is the moved desktop test, unchanged in assertions; desktop CPU tests pass unchanged.

**Memory and Network (lane b)**
- Memory: header "N GB unified" on the Mac and MemTotal on Linux; composition stack bar and strip (Used, Pressure or Pressure stall, Swap, Compressed, Peak used, Peak swap); pressure chart on the Mac, Used/Cached on Linux; swap card with Used, In, Out and a chart; processes by memory.
- Network header, one test per state: `known` shows "en0 · 143 Mb/s link · 192.168.86.242 · Public 76.143.14.53"; IPv6 adds a second caption line; `pending` shows "Public …" and polls every 2 s at most 5 times only while the page is focused (fake timers: blur stops polling); `unavailable` shows "Public unavailable" with the reason as the accessibility hint; `unknown` shows "Public unavailable"; an old host (`RemoteUnsupported`) shows the interface and link speed from the live frame and no address line. Addresses are fetched on focus only.
- Network strip: Download lead, Upload, Of link, and range totals; the mirrored history chart has upload above and download below with a labelled ceiling per direction and time ticks, replacing the two area lines; the interfaces list; processes by rate (`network: true`).
- No `AppsCard`, `AppsNowCard` or selection text; no power event on the page.
- `packages/core/src/network-lines.test.ts` covers `interfaceRows`, `ofLink` and `networkSubtitle` moved from the desktop; the desktop Network page tests pass unchanged.

**Power & Sensors and Battery (lane c)**
- Power & Sensors, Mac fixture: subtitle (power source, system draw); four rings (CPU temperature with P-cluster, GPU temperature with frequency, Fans RPM with left/right and mode, System W with source and package) from `ringGaugeModel`; strip (System W, CPU, GPU, ANE, DRAM, Avg, Peak); the ticked power chart with its legend and the note from `@core/cpu-power-source`; the thermal zones heatmap with legend and current value per zone; the battery day card when present; processes by energy.
- Linux fixture: rings and zones the host doesn't report are omitted, by the same rule as the cards.
- Temperature unit: with a Fahrenheit locale every temperature on the page (rings, zones legend, current values) is °F; with a Celsius locale °C; a test sets each through `expo-localization`'s jest mock.
- The title is "Power & Sensors"; no "Drag across the chart" text and no app power lines.
- Battery: header charge state; rings for Charge, Health and Cycles, and Power; the battery day chart with Charge, Health, Cycles, Remaining, Full charge and Temperature; processes by energy.
- Annotations on the power chart are the page's `power_spike`, `fans_ramped` and `thermal_state` events as pills; two at the same minute form a second row or "+N".

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | apps/mobile/src/module/pages/cpu/, apps/mobile/src/module/pages/gpu/, packages/core/src/cpu-clusters.ts, packages/core/src/cpu-clusters.test.ts, src/app/routes/dashboard/cpu/_lib/clusters.ts, src/app/routes/dashboard/cpu/_lib/clusters.test.ts, apps/mobile/test/module/cpu/, apps/mobile/test/module/gpu/ | contracts, RFC 4.6 (CPU, GPU rows); `src/app/routes/dashboard/cpu/`, `gpu/`; `.claude/skills/widget-model/` | sections ported on Mac and Linux fixtures, separate per-core query, process sort, omitted sections absent | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/cpu-clusters.test.ts src/app/routes/dashboard/cpu`, `bun run typecheck`, `bun run --cwd apps/mobile test -- test/module`, `make mobile-check`; CPU and GPU page screenshots in light, dark and AX1 next to `/dashboard/cpu` and `/dashboard/gpu` |
| b | L | apps/mobile/src/module/pages/memory/, apps/mobile/src/module/pages/network/, apps/mobile/src/data/addresses.ts, packages/core/src/network-lines.ts, packages/core/src/network-lines.test.ts, src/app/routes/dashboard/network/_lib/network.ts, apps/mobile/test/module/memory/, apps/mobile/test/module/network/ | contracts, RFC 4.6 (Memory, Network rows, Network header), D-153; `src/app/routes/dashboard/memory/`, `network/`, `src/app/components/live-mirror-chart.tsx` | memory sections both OSes, every address state with the bounded poll, mirrored history bars, no attribution | gpt-6.2-sol | pending | | `bun run test -- packages/core/src/network-lines.test.ts src/app/routes/dashboard/network`, `bun run typecheck`, `bun run --cwd apps/mobile test -- test/module`, `make mobile-check`; Memory and Network screenshots in light, dark and AX1 next to the dashboard pages; the Network header against the Docker host |
| c | L | apps/mobile/src/module/pages/power/, apps/mobile/src/module/pages/battery/, apps/mobile/src/data/temperature-unit.ts, apps/mobile/test/module/power/, apps/mobile/test/module/battery/ | contracts, RFC 4.6 (Power & Sensors, Battery rows); `src/app/routes/dashboard/power/`, `src/app/components/battery-day-card.tsx`, `@core/cpu-power-source` | rings, strip, ticked chart with notes, zones heatmap, °C and °F from the locale, Linux omission, battery page | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/module`, `make mobile-check`; Power & Sensors and Battery screenshots in light, dark and AX1 with a Celsius and a Fahrenheit simulator region, next to `/dashboard/power` and `/dashboard/battery` |

Ownership:
- **The scaffold owns `module/pages/index.ts` and the mocks.** Each lane fills its own page directories; the registry already points at them.
- **The mock answers are checked once in the scaffold.** No lane edits `packages/core/src/mock/`; the scaffold confirms the mock answers every selector the three lanes request and adds what's missing in the same change (`data-boundary.md`).
- **Code moves to core only with its second consumer.** Lane a moves `clusters.ts`, lane b moves `network/_lib/network.ts`; each desktop file becomes a re-export and its desktop tests pass unchanged. Battery-day and power-chart logic stays per app unless a lane finds the phone needs the same function; then that lane moves it and lists it in its report.

#### Scaffold contracts (phase 12)

Inline before dispatch:
- Create `apps/mobile/src/module/pages/{cpu,gpu,memory,network,power,battery}/index.tsx`, each a stub rendering the generic page, and point `MODULE_PAGES` at them.
- Stub `packages/core/src/cpu-clusters.ts` and `packages/core/src/network-lines.ts` as re-exports of the desktop files (lanes move the bodies).
- Run each module's page against the mock with a recording transport, list every `hostHistory` selector and `networkAddresses` call the RFC 4.6 sections need, and add any series the mock doesn't answer (per-core `cpu.load{core}`, `thermal.zone{sensor}`, GPU residency, swap in and out, per-interface `net.rx`/`net.tx`), with a mock test for each addition.
- Then `bun run typecheck`, `make mobile-check`, `bun run test -- packages/core/src/mock`.

```ts
// apps/mobile/src/module/pages/<module>/index.tsx (one lane each)
export default function CpuPage(props: ModulePageProps): JSX.Element; // GpuPage, MemoryPage, NetworkPage, PowerPage, BatteryPage
// packages/core/src/cpu-clusters.ts (lane a): moved from src/app/routes/dashboard/cpu/_lib/clusters.ts
export function clusterViews(topology: readonly ClusterInfo[]): ClusterView[];
export function coreCounts(info: HostInfo): { performance: number; efficiency: number; total: number };
// packages/core/src/network-lines.ts (lane b): moved from src/app/routes/dashboard/network/_lib/network.ts
export function interfaceRows(/* as today */): InterfaceRow[];
export function ofLink(/* as today */): string;
export function networkSubtitle(/* as today */): string;
// apps/mobile/src/data/addresses.ts (lane b)
export function useHostAddresses(host: HostId): { line: string | null; ipv6: string | null; hint: string | null; supported: boolean };
// apps/mobile/src/data/temperature-unit.ts (lane c)
export function useTemperatureUnits(): TemperatureUnits; // "C" | "F" from getLocales()[0].temperatureUnit, "C" when unknown
```

#### Lane a brief
- **Goal:** the CPU and GPU pages show what the dashboard's pages show, minus investigation.
- **Interface:** `ModulePageProps`, `ModuleFrame`, `StatStrip`, `ModuleChart`, `LiveProcessTable`, `HeatMatrix`, `RingGauge`, `useHostHistory`, `clusterViews`, `coreCounts`.
- **Behavior:**
  - Port the sections in RFC 4.6's CPU and GPU rows, one column, in the desktop's order. Each figure comes from a selector or the answer's `stats` through `@core/format`.
  - The per-core heatmap issues its own `useHostHistory` with only `cpu.load{core=*}` selectors and its column count as the budget, separate from the page's other charts, so the 256-series clamp applies and a host with more than 32 cores draws every core.
  - Move `clusters.ts` and its test to core; the desktop file re-exports.
  - Processes: CPU sorts by CPU %; GPU passes `gpu: true`.
- **Decisions already made:** `UsageAppsCard` and the "Every process" link are omitted (per-app over a range is the user's non-goal and the session refuses it); live processes stay (the user's process-table decision).
- **Out of scope:** the frame (phase 11 lane e), other modules.
- **Done when:** the table's Done-when conditions are met.

#### Lane b brief
- **Goal:** the Memory and Network pages match the dashboard, and Network shows the host's addresses.
- **Interface:** `ModulePageProps`, the frame components, `useHostAddresses`, `networkAddresses` (phase 7 lane h), `mirrorBarsModel`, `valueTicks`, `timeTicks`.
- **Behavior:**
  - Memory: RFC 4.6's Memory row; the chart choice (pressure or Used/Cached) follows what the host reports, not an OS check.
  - Network header: fetch `networkAddresses` on focus only; while `pending`, poll every 2 s at most 5 times while focused; `PublicIp.state` selects the text as in the Test cases; `RemoteUnsupported` falls back to the live frame's interface and link speed with no address line.
  - The mirrored history chart is a phone renderer over `mirrorBarsModel` with a labelled ceiling per direction and `timeTicks`, replacing today's two overlapping area lines.
  - Move `network/_lib/network.ts` to core as `network-lines.ts`; the desktop file re-exports.
- **Decisions already made:** the header shows interface, link speed, local IPv4/IPv6 and the public IP served by the host; the strip has Download, Upload, Of link and range totals; mirrored bars on the page (the user's Network decision, D-153); `AppsCard`, `AppsNowCard` and `SelectionSummary` are omitted (attribution and selection, the user's non-goal).
- **Out of scope:** the resolver and the wire (phase 7 lane h), the desktop surfaces (phase 8 lane e).
- **Done when:** the table's Done-when conditions are met.

#### Lane c brief
- **Goal:** the Power & Sensors and Battery pages match the dashboard, with temperatures in the phone's locale unit.
- **Interface:** `ModulePageProps`, the frame components, `RingGauge`, `HeatMatrix`, `useTemperatureUnits`.
- **Behavior:**
  - Port RFC 4.6's Power & Sensors and Battery rows, one column. Rings sit two per row at the default size and one per row at AX1.
  - Temperature unit: `useTemperatureUnits()` reads `getLocales()[0].temperatureUnit` and passes `units` to every `formatTemperature` and to the heat and ring models; no phone setting.
  - The power chart's legend and notes come from `@core/cpu-power-source`; annotations are the page's own events as pills.
  - Linux hosts omit rings and zones they don't report.
- **Decisions already made:** all servable Power & Sensors sections port; out are "Drag across the chart to see what used it" and the app power lines (the user's Power & Sensors decision); the module is "Power & Sensors" everywhere; the unit follows the iOS locale's measurement system (RFC 4.6).
- **Out of scope:** the heat and ring models (phase 10 lane d), the frame.
- **Done when:** the table's Done-when conditions are met.

### Phase 13: App Store readiness

Demo:
- **Release archive, locally:** `make mobile-archive` builds the XCFramework, prebuilds, and archives a signed Release build with `xcodebuild`. It exports an App Store `.ipa` into `apps/mobile/dist/ios/` and uploads nothing. `make mobile-release-check` then passes on that archive and prints one line per check: Info.plist keys, the privacy manifest in the bundle against the binary's imports, no private symbols or private frameworks, the icon, the entitlements and the version.
- **Simulator, Release build, light, dark and AX1:**
  - The home screen shows the StatGlass icon in light, dark and tinted, not Expo's blank placeholder.
  - The launch screen uses the theme background in light and dark, with no white flash in dark.
  - The first launch shows the welcome screen. "Try demo hosts", then a host, then a module page all work, and `log stream` shows no session dial from subsystem `app.statglass`.
  - `statglass://debug` redirects to `/`.
  - Settings > About shows "1.0.0 (N)" with "Privacy policy" and "Support" rows that open the docs page.
- **iPad simulator:** the iPhone-only app runs in compatibility mode with nothing clipped. In the iPhone Duo simulator (if the installed runtime has one), the closed and open postures render without black bars.
- **Docs:** `/docs/iphone` renders, with its Privacy and Support sections.
- **IPv6:** a russh session to the test SSH server on `[::1]` completes its handshake. On Apple targets an IPv4 literal goes through `getaddrinfo`, so a NAT64 network can synthesize its address.
- **Checklist:** `.github/releasing-mobile.md` holds the steps the user completes in App Store Connect, the review notes text, and the device checks the simulator can't do.

Depends on: phase 9, phase 12

Why a phase: the user wants StatGlass for iPhone submitted to the App Store. This phase gets the code to the point where it passes App Review. It reopens the App Store part of RFC phases 5 and 6, which the Spec's out-of-scope line had deferred. Uploading, the App Store Connect record and submission stay the user's own steps; the phase ends with an archive and a checklist. It runs after phase 12 because review judges the finished screens, and lanes a and c edit files that phases 8, 11 and 12 own (`app.config.ts`, the root layout, About, `demo.tsx`).

Requirements (primary sources, read 2026-11-25):
- **Review Guidelines** (https://developer.apple.com/app-store/review/guidelines/):
  - "Before You Submit" asks for a demo account or "fully-featured demo mode", and any hardware or resources review needs ("a sample QR code").
  - 2.1(a): a built-in demo mode "in lieu of a demo account" needs Apple's prior approval. This app has no login, so the review notes explain the demo instead.
  - 2.3.1(a): describe features "with specificity in the Notes for Review".
  - 2.3.3: screenshots show the app in use.
  - 2.4.1: iPhone apps should run on iPad.
  - 2.5.5: the app must be "fully functional on IPv6-only networks".
  - 4.2: minimum functionality.
  - 5.1.1(i): every app links its privacy policy in App Store Connect and inside the app.
  - 5.1.1(ii): purpose strings "clearly and completely describe" the use.
  - Not re-read in this pass: whether 4.2.3's "work on its own without requiring installation of another app" applies to a companion to server software.
- **Privacy manifests:**
  - Required-reason API rules: https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api (enforced on upload since 1 May 2024).
  - Reason codes: https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype. The codes used here:
    - FileTimestamp (`stat`, `fstat`, `lstat`, `getattrlist*`): C617.1, files in the app container.
    - SystemBootTime (`mach_absolute_time`, `systemUptime`): 35F9.1, elapsed time and timers.
    - DiskSpace (`statfs`, `fstatfs`, `statvfs`): E174.1, check space before writing.
    - UserDefaults: CA92.1, the app's own defaults.
  - Third-party SDK list: https://developer.apple.com/support/third-party-SDK-requirements/. `hermes` is on it; React Native and Expo are not. A static library linked into the app is app code, so its reasons go in the app's manifest.
- **Expo privacy guidance:** https://docs.expo.dev/guides/apple-privacy/. Set `ios.privacyManifests` in the app config and restate the pods' reasons there, because "Apple does not correctly parse all the PrivacyInfo files included by static CocoaPods dependencies".
- **App Privacy labels:** https://developer.apple.com/app-store/app-privacy-details/. "Collect" means transmitting data off the device so that "you and/or your third-party partners" can access it. Data that reaches only the user's own hosts is therefore not collected, so the label is Data Not Collected; that is an inference, and the page has no rule naming user-owned servers. A privacy policy URL is required.
- **Export compliance:**
  - https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations: the key is `NO` only if the app uses no encryption or only exempt encryption. "Proprietary" or non-OS encryption is typically not exempt.
  - https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption: a "standard algorithm, not provided within the Apple operating system" needs a French encryption declaration, and only if the app is distributed in France.
  - https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption: without the key, App Store Connect asks the questionnaire on every upload.
  - https://developer.apple.com/documentation/bundleresources/information-property-list/itsencryptionexportcompliancecode: the code Apple issues after reviewing the documents.
  - BIS self-classification: https://www.bis.gov/learn-support/encryption-controls/annual-self-classification.
- **Local network:**
  - TN3179 (https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy): an outgoing TCP connection to a local address needs access, through any API including BSD sockets. Cellular and VPN don't count as local. `NSBonjourServices` is needed only for Bonjour.
  - `NSLocalNetworkUsageDescription`: https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription.
- **Camera:**
  - `NSCameraUsageDescription` is required: https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription.
  - The `expo-camera` plugin adds `NSMicrophoneUsageDescription` unless `microphonePermission: false`: https://docs.expo.dev/versions/latest/sdk/camera/ and `packages/expo-camera/plugin/src/withCamera.ts`.
- **Icon and launch screen:**
  - App icons are 1024 px, a bitmap or an Icon Composer file, with dark and tinted variants generated if missing: https://developer.apple.com/design/human-interface-guidelines/app-icons.
  - Every app needs a launch screen: https://developer.apple.com/documentation/xcode/specifying-your-apps-launch-screen.
  - Expo's `ios.icon` takes a path, a `.icon` directory, or `{ light, dark, tinted }`: https://docs.expo.dev/versions/latest/config/app/.
- **IPv6:**
  - https://developer.apple.com/support/ipv6/.
  - Test with a NAT64 network from Internet Sharing, and resolve IPv4 literals with `getaddrinfo` to get a synthesized address: https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/NetworkingOverview/UnderstandingandPreparingfortheIPv6Transition/UnderstandingandPreparingfortheIPv6Transition.html.
- **Upload minimums** (https://developer.apple.com/news/upcoming-requirements/):
  - Since 28 April 2026: Xcode 26 or later with the iOS 26 SDK. This Mac has Xcode 27.2 with the iOS 27.2 SDK.
  - Since 9 September 2026: target iOS 13 or later. The prebuild sets 16.4.
  - Nothing is announced for 2027 on that page. The screenshot page, though, says iPhone Duo screenshots become required in April 2027 for apps built with the iOS 27.1 SDK or later, which a build from this Xcode is.
- **Screenshots:**
  - https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications: one iPhone set (1206x2622 or 1179x2556), no alpha.
  - The 13-inch iPad set is required only if the app supports iPad.
- **Accessibility Nutrition Labels** are voluntary for now: https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels.
- **Local release route:** https://docs.expo.dev/submit/ios-manual/. Archive locally, then upload through Organizer or Transporter, which is the user's step.

Audit (2026-11-25, this worktree, with an `expo prebuild --platform ios --no-install` run in a scratch copy and since deleted). Blocking means App Store Connect or App Review would reject the build:

- **Blocking:**
  - **No icon.** `app.config.ts` sets no `icon`. Prebuild writes Expo's placeholder, a blank white 1024 PNG with an alpha channel (`AppIcon.appiconset/App-Icon-1024x1024@1x.png`, md5 `35a635a6c61497e3e5c08c0d66a2816f`). `brand/statglass-app-icon.svg` and `brand/build.mjs` already make the mark and a full-bleed crop for the web touch icon.
  - **No privacy manifest.**
    - The app config sets no `ios.privacyManifests`, and the prebuilt project has no `PrivacyInfo.xcprivacy`.
    - The Podfile aggregates pod manifests only at `pod install` (`privacy_file_aggregation_enabled`).
    - Expo modules are precompiled (`EXPO_USE_PRECOMPILED_MODULES` defaults to 1) and static, so per Expo's guidance their reasons must be restated in the app.
    - The Rust staticlib ships no manifest of its own. It imports `stat`, `fstat`, `lstat`, `statfs` and `fstatfs` (checked with `nm` on the `aarch64-apple-ios` `libstatglass_mobile.a` built in the ios-p7a worktree on 2026-11-25). `statfs`/`fstatfs` come from bundled SQLite (`statglass-store`, `rusqlite` with `bundled`), which the phone still links for `phone_id.rs`.
  - **Version 0.0.0 and a fixed build number.**
    - `apps/mobile/package.json:4` is `"version": "0.0.0"`, so prebuild writes `CFBundleShortVersionString` 0.0.0. `app.config.ts:47-70` sets neither `version` nor `ios.buildNumber`, so `CFBundleVersion` is always `1`.
    - Every upload needs a new build number. RFC 7.3 versions the phone on its own (`mobile-vX.Y.Z`, monotonic build numbers).
    - About reads `Constants.expoConfig?.version` (`settings/about.tsx:16`).
  - **No in-app privacy policy link (5.1.1(i)).**
    - About has only version, core and protocol rows (`settings/about.tsx:13-23`). Phase 11 lane a adds a licenses link only.
    - `docs-site/src/content/docs/privacy.md` covers the Mac app and the website and says nothing about the iPhone.
  - **No export compliance answer.** No `ios.config.usesNonExemptEncryption`, so `ITSAppUsesNonExemptEncryption` is absent and every upload stops at the questionnaire. The app's SSH uses russh with ring, p256 and sha2 (non-OS crypto) for key exchange, transport encryption and signing, while the Secure Enclave key uses CryptoKit/Security. The classification is the user's decision (below).
- **Blocking unless changed in phase 8:** the phase 8 scaffold adds `NSLocalNetworkUsageDescription` and the `expo-camera` plugin with its camera string (plan line 3021).
  - It doesn't pass `microphonePermission: false`, so prebuild also writes `NSMicrophoneUsageDescription` with Expo's generic "Allow $(PRODUCT_NAME) to access your microphone", which the app never uses.
  - That is a vague purpose string for an unused permission (5.1.1(ii)). Lane a removes it.
- **Advisory:**
  - **Debug and scenario routes in release.** `/debug` is registered in the root stack (`app/_layout.tsx:43`) and reachable through the `statglass` URL scheme in a release build. `/demo?scenario=` loads developer scenarios such as `phone-errors`. Review dislikes hidden features (2.3.1), so release builds redirect both.
  - **Orientation.**
    - The prebuilt `UISupportedInterfaceOrientations` allows all four orientations, because `app.config.ts` sets no `orientation`. The phone screens are designed for portrait only.
    - Set `orientation: "portrait"`. Leave `UIRequiresFullScreen` false so iPad compatibility mode and the iPhone Duo's open posture aren't letterboxed.
  - **Launch screen.** `SplashScreen.storyboard` names an image `SplashScreen` that the asset catalog doesn't have, and it uses `systemBackgroundColor`. `expo-splash-screen` isn't installed. It works, but it doesn't match the theme.
  - **IPv4 literals and NAT64.**
    - `crates/statglass-ssh/src/dialer.rs:188-190` notes that numeric IPv4 literals bypass `getaddrinfo` (tokio parses them first), so they get no NAT64 synthesis. The 2026-11-24 Log calls this a known limitation.
    - Pairing targets are often literals (LAN and Tailscale addresses). Review itself uses demo mode, which opens no socket, so this doesn't block review, but 2.5.5 applies to the real app.
  - **Strings naming private frameworks.** The staticlib has no IOKit or private-framework imports (`nm` found no `_IO*` symbols; `crates/statglass-collect` is gated off iOS). Its strings do contain `statglass_schema::caps` doc text that names "Private IOReport framework" and "IOHIDEventSystemClient" (`crates/statglass-schema/src/caps.rs:204,208`).
    - The upload scan checks symbols and selectors, so lane v's check fails on symbols and only reports these strings.
    - Other imports: `dlopen`/`dlsym` (Rust std's OS-version probe of CoreFoundation, and SQLite's extension loader) and `sysctlbyname` (`hw.*` CPU features for ring). None needs a declared reason.
  - **ATS is already right.** The prebuilt plist has `NSAllowsArbitraryLoads` false and `NSAllowsLocalNetworking` true. The phone makes no HTTP requests; the public IP lookup is host-side (D-093).
  - **Entitlements are empty** (`StatGlass.entitlements` is `<dict/>`). The Secure Enclave key uses the app's default keychain group and needs none.
  - **iPhone only.**
    - `supportsTablet: false` (`app.config.ts:58`), so `TARGETED_DEVICE_FAMILY` is 1. Review may still run the app on an iPad in compatibility mode (2.4.1), and no iPad screenshots are needed.
    - The RFC lists iPad as later work.
  - **4.2 minimum functionality and the companion question.** Real use needs StatGlass on a Mac or `statglass-agent` on Linux.
    - After phase 11 lane b, the welcome screen offers "Try demo hosts" in one tap. The demo is the full app on the mock transport: live cards, module pages and history.
    - The review notes name the companion software, explain the QR pairing, and point to the demo. Whether to also give review a live host is the user's decision (below).
    - A pairing QR expires within minutes (`decode_payload`'s expiry), so a printed sample QR can't work.
  - **5.1.1 data.** The phone keeps no history (D-152), sends no analytics, and has no account (so 5.1.1(v), account deletion, doesn't apply). Logs go to os_log only (phase 7 lane l). The diagnostics export is deferred (`plan/rfc-ios-polish.md` section 9). The label is Data Not Collected; RFC 7.4 says the same.
  - **First launch offline.**
    - With no paired hosts, phase 8's launch logic starts the core and shows welcome. No socket opens until a host is paired, and the Local Network prompt appears only on the first LAN dial (TN3179).
    - Phase 11 lane b covers the welcome states. This phase adds a test of the full reviewer path with no native session call.
  - **Accessibility.** Phases 10 to 12 cover VoiceOver labels, 44 pt targets and AX1 layouts. The Accessibility Inspector audit and the voluntary Nutrition Label answers are checklist items.
  - **Hermes signature.** `hermes` is on Apple's SDK list. React Native's prebuilt `hermes-engine` ships its own manifest; lane v reports whether its xcframework is signed, because an unsigned listed SDK draws a warning on upload.
  - **Duo screenshots.** A build from Xcode 27.2 uses the iOS 27.2 SDK, so iPhone Duo screenshots become required from April 2027. The checklist says so.

Code facts this phase relies on (checked 2026-11-25; the state after phases 8 to 12 land):
- **App config.**
  - `apps/mobile/app.config.ts:43-71` `expoConfigFor(identity, base)` returns `ios: { bundleIdentifier, appleTeamId, supportsTablet: false }` and three plugins. After phase 8 it also carries `ios.infoPlist.NSLocalNetworkUsageDescription` and the `expo-camera` plugin.
  - `apps/mobile/test/app-config.test.ts` tests the identity fallbacks and `expoConfigFor`.
- **Prebuild facts** (Expo 58 template, `node_modules/expo/template.tgz`):
  - The `SplashScreen.storyboard` launch screen.
  - `NSAllowsArbitraryLoads` false and `NSAllowsLocalNetworking` true.
  - `UIRequiredDeviceCapabilities` `arm64`, `IPHONEOS_DEPLOYMENT_TARGET` 16.4, `TARGETED_DEVICE_FAMILY` 1.
  - A Podfile with `privacy_file_aggregation_enabled` on unless `apple.privacyManifestAggregationEnabled` is `false`.
  - The `.gitignore` ignores `apps/mobile/ios/` and `apps/mobile/dist/`.
- **Rust build.** `scripts/mobile/build-rust-ios.sh` builds `libstatglass_mobile.a` with the `mobile-release` profile for `aarch64-apple-ios` and `aarch64-apple-ios-sim` into `apps/mobile/modules/statglass-native/ios/StatglassCore.xcframework`. The podspec vendors it as a static framework (`StatglassNative.podspec`).
- **Swift module.** It uses Keychain and Secure Enclave (`PhoneKey.swift:99-138`), `NWPathMonitor` (`AppLifecycle.swift:13`), and Application Support (`StatglassNativeModule.swift:134`). None of these is a required-reason API.
- **Brand.** `brand/build.mjs` renders `statglass-app-icon.svg` with `rsvg-convert` and already writes a full-bleed square crop for `docs-site/public/apple-touch-icon.png`. The theme backgrounds are `#fafafa` (light) and `#09090b` (dark) in `apps/mobile/src/theme.generated.ts:6,73`.
- **Docs site.**
  - The docs live at `https://statglass.steamfield.io` (`docs-site/astro.config.mjs:11`), with pages from `docs-site/src/content/docs/*.md` and `make -C docs-site check test`.
  - No workflow in `.github/workflows/` deploys it, so the user confirms the page is live before submitting.
- **Routes.** `/debug` is registered in `apps/mobile/src/app/_layout.tsx` (line 43 today; phase 11 lane a owns the layout's options). The welcome screen with "Try demo hosts" is phase 11 lane b's `WelcomeScreen`. `/demo` reads a `scenario` param (phase 7 lane a).
- **Dialer.** `crates/statglass-ssh/src/dialer.rs:187-205` `connect_tcp` resolves with `tokio::net::lookup_host` and tries each address in turn. `crates/statglass-ssh/tests/support/server.rs` is an in-process SSH server.
- **Release policy.** Release builds are local, with no EAS and no hosted macOS job (D-118, D-131, RFC 7.2). `compat/mobile-protocol.json` is empty until the first release.

Test cases:

**App config (lane a)**
- `expoConfigFor`:
  - `version` comes from `apps/mobile/package.json` (1.0.0 after the scaffold).
  - `ios.buildNumber` comes from `STATGLASS_MOBILE_BUILD_NUMBER`, a positive integer. A non-numeric value throws a named error, and unset defaults to `"1"`.
  - `orientation` is `"portrait"`, and `ios.supportsTablet` stays `false`.
  - `ios.config.usesNonExemptEncryption` equals the value the scaffold's D-entry records.
- The privacy manifest (`ios.privacyManifests`):
  - `NSPrivacyTracking` is false, and `NSPrivacyTrackingDomains` and `NSPrivacyCollectedDataTypes` are empty.
  - `NSPrivacyAccessedAPITypes` lists FileTimestamp C617.1, DiskSpace E174.1, SystemBootTime 35F9.1 and UserDefaults CA92.1, each with a comment naming its caller (Rust std and SQLite, React Native, Expo modules).
  - It also lists every further category and reason found in the aggregated manifest of a `pod install` run, which the lane records in its report.
- Plugins:
  - The `expo-camera` plugin keeps phase 8's camera string and passes `microphonePermission: false`.
  - The `expo-splash-screen` plugin sets the image `./assets/splash-icon.png` and the backgrounds `#fafafa` and `#09090b` (dark), taken from `theme.generated.ts`, not typed twice.
  - `ios.icon` is `{ light: "./assets/icon-light.png", dark: "./assets/icon-dark.png", tinted: "./assets/icon-tinted.png" }`.
- Info.plist:
  - `NSLocalNetworkUsageDescription`, `NSFaceIDUsageDescription` and the camera string are present, and none starts with "Allow $(PRODUCT_NAME)".
  - No `NSBonjourServices`.

**Icon and launch screen (lane b)**
- `node brand/build.mjs` writes the four `apps/mobile/assets/` PNGs:
  - `icon-light.png`: 1024x1024 with no alpha (`sips -g hasAlpha` says `no`), the full-bleed mark on its dark background, the same crop as the touch icon.
  - `icon-dark.png`: the mark on a transparent background.
  - `icon-tinted.png`: grayscale with transparency.
  - `splash-icon.png`: the mark alone, transparent.
- A second run is byte-identical.
- `brand/README.md` lists the outputs.

**Release surfaces (lane c)**
- With `__DEV__` false:
  - `/debug` renders a redirect to `/`, and the root stack registers no `debug` screen options.
  - `/demo?scenario=phone-errors` starts the default demo scenario.
  - With `__DEV__` true, both behave as today.
- About:
  - The rows are App version "1.0.0 (N)" (from `expoConfig.version` and `ios.buildNumber`), Core and Protocol, then "Privacy policy" and "Support".
  - Each link row is a 44 pt `link`-role row that calls `Linking.openURL` with the URL from `apps/mobile/src/lib/links.ts`: `https://statglass.steamfield.io/docs/iphone#privacy` and `#support`.
  - A failed `openURL` shows an inline "Couldn't open the page" with the URL as text.
- The reviewer path, on `FakeNative` with no stored hosts: the welcome screen shows, then "Try demo hosts" (found by role and label), the hosts list, a host, and the CPU module page. Every step renders, and `FakeNative` records no session start, dial or pairing call.

**Privacy and support page (lane d)**
- `docs-site/src/content/docs/iphone.md`:
  - It covers what the app does, what it needs (StatGlass on a Mac or `statglass-agent` on Linux), pairing, and demo hosts.
  - `## Privacy` says the app sends nothing to the developer and has no account, analytics or ads. Metrics travel over SSH straight from the user's hosts, and the phone stores no history (D-152). The key lives in the Secure Enclave (Keychain on the simulator). It lists the camera (only for scanning the pairing code), Local Network (only for hosts on the same network) and Face ID (optional App Lock), says how to remove a host and revoke the key on the host, and says the website's analytics are separate (link to `privacy.md`).
  - `## Support` names GitHub issues.
- `privacy.md` links to the iPhone section.
- `make -C docs-site check test` passes, and the built site has `/docs/iphone/` with both anchors.

**NAT64 literals (lane e)**
- On `target_vendor = "apple"`, `resolve(host, port)`:
  - It uses `getaddrinfo` with `AF_UNSPEC`, `SOCK_STREAM` and `AI_DEFAULT` on `spawn_blocking` for names and literals alike.
  - `"127.0.0.1"` returns `127.0.0.1:port`, and `"::1"` returns `[::1]:port`.
  - An unresolvable name maps to `Unreachable { kind: NameNotResolved }` with the host in the detail.
- Elsewhere `lookup_host` is unchanged (Linux CI runs that branch).
- `tests/ipv6.rs`: a russh session to `tests/support/server.rs` bound on `[::1]` completes the handshake, skipped with a message when the machine has no IPv6 loopback.
- `cargo test -p statglass-ssh` and `make mobile-rust-check` pass.

**Archive and static checks (lane v)**
- `scripts/mobile/release-check-test.sh` builds fixture bundles with `clang` and `plutil`: a minimal `.app` with an Info.plist, a `PrivacyInfo.xcprivacy` and a tiny Mach-O.
  - The good fixture passes.
  - Each of these fails with its own message:
    - a missing `ITSAppUsesNonExemptEncryption`;
    - an `NSMicrophoneUsageDescription`;
    - a purpose string starting "Allow $(PRODUCT_NAME)";
    - `NSAllowsArbitraryLoads` true;
    - a landscape orientation;
    - `CFBundleShortVersionString` 0.0.0;
    - a binary importing `_mach_absolute_time` with no SystemBootTime reason;
    - a binary importing a symbol from `private-symbols.txt`;
    - a `/System/Library/PrivateFrameworks/` load command;
    - the placeholder icon hash;
    - a `get-task-allow` entitlement.
- `scripts/mobile/archive.sh` never uploads: a grep test finds no `altool`, `notarytool` or `destination upload` in it or in `ExportOptions.plist`.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | apps/mobile/app.config.ts, apps/mobile/test/app-config.test.ts | contracts, audit above, https://docs.expo.dev/guides/apple-privacy/, the required-reason page, the Expo camera and splash-screen docs | config keys, manifest reasons, plugins, purpose strings | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test -- test/app-config.test.ts`, `make mobile-check`; a scratch-copy `expo prebuild --platform ios` plus `pod install` whose Info.plist and aggregated `PrivacyInfo.xcprivacy` are attached to the report, scratch copy deleted |
| b | S | brand/build.mjs, brand/README.md, apps/mobile/assets/ | contracts, `brand/statglass-app-icon.svg`, the HIG app icon page | four PNGs, opaque light icon, idempotent | gpt-6.2-sol | pending | | `node brand/build.mjs` twice with no diff on the second run; `sips -g hasAlpha apps/mobile/assets/icon-light.png` says `no`; simulator home-screen screenshots in light, dark and tinted, compared with the macOS icon |
| c | M | apps/mobile/src/app/debug.tsx, apps/mobile/src/app/_layout.tsx, apps/mobile/src/app/demo.tsx, apps/mobile/src/app/settings/about.tsx, apps/mobile/src/lib/links.ts, apps/mobile/test/settings/about.test.tsx, apps/mobile/test/app/release-routes.test.tsx, apps/mobile/test/app/reviewer-path.test.tsx | contracts, guidelines 2.1, 2.3.1, 5.1.1(i), `.claude/rules/mobile/expo.md` | release redirects, About links, reviewer path with no session calls | gpt-6.2-sol | pending | | `bun run --cwd apps/mobile test`, `make mobile-check`; simulator screenshots of About in light, dark and AX1 next to the other settings pages |
| d | S | docs-site/src/content/docs/iphone.md, docs-site/src/content/docs/privacy.md | contracts, D-152, guideline 5.1.1, the App Privacy details page | page builds with both anchors | gpt-6.2-sol | pending | | `make -C docs-site check test build`; the built `/docs/iphone/` page screenshotted in light and dark |
| e | S | crates/statglass-ssh/src/dialer.rs, crates/statglass-ssh/src/dialer/resolve.rs, crates/statglass-ssh/tests/ipv6.rs, crates/statglass-ssh/Cargo.toml, Cargo.lock | contracts, Apple's IPv6 transition guide, `.claude/rules/rust/platform.md` | literal and name resolution, IPv6 loopback handshake | gpt-6.2-sol | pending | | `cargo test -p statglass-ssh`, `make rust-check`, `make mobile-rust-check`, `make rust-linux-check` |
| v | L | scripts/mobile/archive.sh, scripts/mobile/release-check.sh, scripts/mobile/release-check-test.sh, scripts/mobile/ExportOptions.plist, scripts/mobile/fixtures/release/, Makefile, .github/releasing-mobile.md | contracts, every requirement URL above, D-118, D-131, `.github/releasing.md`, `.claude/skills/ios-simulator/` | fixture pass and each named failure, no-upload grep | gpt-6.2-sol | pending | | `make mobile-release-check-test`; after lanes a to e merge, rebased on the phase branch: `make mobile-archive` and `make mobile-release-check` pass on the archive, plus the simulator runs in lane v's brief, with results in the Log |

Ownership:
- **The scaffold owns the lockfiles' JS side and the version.** It runs `bunx expo install expo-splash-screen` in `apps/mobile` (`apps/mobile/package.json`, `bun.lock`) and sets `apps/mobile/package.json` `version` to `1.0.0`, so no lane edits either file. Lane e owns `Cargo.lock` for its one dependency change.
- **Lanes a and b meet at fixed paths.** Lane a references `apps/mobile/assets/{icon-light,icon-dark,icon-tinted,splash-icon}.png`; lane b writes them. The scaffold commits the first `node brand/build.mjs` output there, so lane a's prebuild runs before b lands.
- **Lane c takes files from earlier phases.** It owns `_layout.tsx`, `demo.tsx` and `about.tsx`, which phases 8 and 11 owned and which are merged before this phase starts.
- **Lane v rebases last.** It writes and fixture-tests its scripts in parallel with the others. Its archive and simulator runs need lanes a to e merged, so it rebases on the phase branch for its final run, as phase 7's j2 did on j1.

#### Scaffold contracts (phase 13)

Inline before dispatch, after the user answers the questions in the "Decisions for the user" list below:
- **D-entry.** It writes the next free D-entry in `plan/decisions.md`: StatGlass for iPhone on the App Store, distinct from D-015 (the Mac app stays off it).
  - It records: iPhone only; portrait; Data Not Collected; the privacy policy at `/docs/iphone#privacy`; versions `1.0.0` with the build number `git rev-list --count HEAD`.
  - It records the user's export compliance answer and the review-access choice.
- **Installs and assets.**
  - It runs `bunx expo install expo-splash-screen` and sets `apps/mobile/package.json` `version` to `1.0.0`.
  - It runs `node brand/build.mjs` once after adding the four mobile outputs as a stub target that copies the touch-icon crop, which lane b replaces.
- **Contracts.**
  - The shared constant below in `apps/mobile/src/lib/links.ts`, as a stub lane c fills.
  - The Make target names below.

```ts
// apps/mobile/src/lib/links.ts (lane c fills; lane d's anchors must match)
export const PRIVACY_POLICY_URL = "https://statglass.steamfield.io/docs/iphone#privacy";
export const SUPPORT_URL = "https://statglass.steamfield.io/docs/iphone#support";
```

```make
# Makefile (lane v fills)
mobile-archive:            # scripts/mobile/archive.sh: Release .xcarchive and App Store .ipa in apps/mobile/dist/ios, no upload
mobile-release-check:      # scripts/mobile/release-check.sh apps/mobile/dist/ios/StatGlass.xcarchive
mobile-release-check-test: # scripts/mobile/release-check-test.sh (fixtures, no Xcode project needed)
```

```rust
// crates/statglass-ssh/src/dialer/resolve.rs (lane e)
pub(crate) async fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, RemoteError>;
```

Decisions for the user (asked before the scaffold; the defaults shown are recommendations):
- **iPad.** Default: iPhone only (`supportsTablet: false`), checked in iPad compatibility mode. Supporting iPad adds a 13-inch screenshot set and layouts the RFC leaves for later.
- **Export compliance.** The app implements standard algorithms (SSH through russh, ring and p256), not only Apple's. The choices:
  1. `usesNonExemptEncryption: true` and the "standard algorithms" answer, with a French declaration or with France excluded from the storefronts.
  2. `false`, on the user's or counsel's reading that an exemption covers it.
  This phase records the answer; it doesn't make the legal call.
- **Privacy policy and support hosting.** Default: `docs-site`, at `/docs/iphone#privacy` and `#support`. The user confirms the docs site deploys before submission.
- **Name and category.**
  - Default name: "StatGlass" (the App Store name must be unique; fallback "StatGlass Monitor").
  - Default category: Utilities, with Developer Tools as secondary.
- **Review access.** Default: demo mode only, explained in the review notes. Optionally, a reachable Linux host with `statglass-agent` for review. Pairing codes expire, so this needs a person available during review.

#### Lane a brief
- **Goal:** the app config produces an Info.plist and a privacy manifest that pass upload and review.
- **Interface:** `expoConfigFor(identity, base)`, `appIdentityFromEnv(env)` gaining `buildNumber`.
- **Behavior:**
  - Behavior is as in Test cases.
  - Derive the manifest's reasons from evidence: run `pod install` in a scratch prebuild, read the aggregated `PrivacyInfo.xcprivacy`, and add the Rust staticlib's categories.
  - Restate everything in `ios.privacyManifests`, with a comment per entry naming the caller.
  - If SQLite's `statfs` is the only DiskSpace use, keep E174.1 and say so in the report. Don't remove SQLite from the phone (`phone_id.rs` needs `statglass-store`).
- **Decisions already made:** iPhone only; portrait; Data Not Collected; the export compliance value is the scaffold's D-entry; the build number comes from the environment (lane v sets it).
- **Out of scope:** icons (lane b), routes (lane c), the archive (lane v).
- **Done when:** the table's Done-when conditions are met.

#### Lane b brief
- **Goal:** a real icon in every iOS appearance, and a launch image that matches the theme.
- **Behavior:**
  - Extend `brand/build.mjs` with the four `apps/mobile/assets/` outputs as in Test cases, from `statglass-app-icon.svg` and `statglass-icon-dark.svg`, using `rsvg-convert` as today.
  - The light icon is opaque (flatten onto the squircle's dark fill, as the touch icon does).
  - Check the result against the macOS icon and the HIG's dark and tinted guidance, and name any difference left.
- **Decisions already made:** PNG variants, not an Icon Composer file (that needs the GUI tool; a later change can add one); same mark as the Mac app.
- **Out of scope:** the app config entries (lane a), the App Store marketing art.
- **Done when:** the table's Done-when conditions are met.

#### Lane c brief
- **Goal:** a release build shows review only what users get, and links its privacy policy.
- **Interface:** `PRIVACY_POLICY_URL`, `SUPPORT_URL`.
- **Behavior:**
  - Behavior is as in Test cases.
  - `debug.tsx` returns `<Redirect href="/" />` unless `__DEV__`, and the root layout registers the debug screen's options only under `__DEV__`.
  - `demo.tsx` ignores `scenario` unless `__DEV__`.
  - About's link rows use phase 10's `ListRow` and match the other settings rows.
  - The reviewer-path test runs on `AppProviders` with `FakeNative`, not `jest.mock` (`.claude/rules/mobile/testing.md`).
- **Decisions already made:** support goes through GitHub issues via the docs page; no in-app email.
- **Out of scope:** the welcome layout (phase 11 lane b), the licenses link (phase 11 lane a).
- **Done when:** the table's Done-when conditions are met.

#### Lane d brief
- **Goal:** one public page that is both the iPhone app's privacy policy and its support page.
- **Behavior:**
  - Behavior is as in Test cases.
  - Use plain statements a reviewer can check against the app's permission prompts.
  - Follow `docs-site/AGENTS.md` and the frontmatter of the neighbouring pages (`group`, `order`).
- **Decisions already made:** hosted on docs-site (pending the user's answer); the website's PostHog text stays in `privacy.md` and isn't repeated.
- **Out of scope:** App Store marketing copy.
- **Done when:** the table's Done-when conditions are met.

#### Lane e brief
- **Goal:** an IPv4 literal from a pairing payload connects on a NAT64 network, as 2.5.5 requires.
- **Behavior:**
  - Behavior is as in Test cases.
  - `connect_tcp` calls `resolve`, and the address order is kept.
  - `libc` is added under `[target.'cfg(target_vendor = "apple")'.dependencies]` (or reused from the workspace pin).
  - The `getaddrinfo` result is freed on every path.
  - Errors keep the existing `RemoteError` kinds.
- **Decisions already made:** no Happy Eyeballs rewrite; addresses are still tried in order within the deadline.
- **Out of scope:** Network.framework, and Bonjour.
- **Done when:** the table's Done-when conditions are met.

#### Lane v brief
- **Goal:** one local command builds what the user uploads, one checks it, and one document lists what only the user can do.
- **Behavior:**
  - **`archive.sh`:**
    - Steps: `build-rust-ios.sh`, then `expo prebuild --platform ios --clean` into the gitignored `apps/mobile/ios/`, then `pod install`.
    - Then `xcodebuild -workspace apps/mobile/ios/StatGlass.xcworkspace -scheme StatGlass -configuration Release -destination generic/platform=iOS -archivePath apps/mobile/dist/ios/StatGlass.xcarchive archive`, with `STATGLASS_MOBILE_BUILD_NUMBER=$(git rev-list --count HEAD)`.
    - Then `-exportArchive` with `ExportOptions.plist` (`method` `app-store-connect`, `destination` `export`, automatic signing, team from the identity).
    - It refuses a dirty tree. It never uploads and never touches hosted CI (D-118, D-131).
  - **`release-check.sh <xcarchive>`** runs every check in Test cases on the archived `.app`:
    - Info.plist keys via `plutil -extract`.
    - `PrivacyInfo.xcprivacy` at the bundle root and in each embedded framework.
    - `nm -u` of the app executable and every embedded binary, against `fixtures/release/required-reason-symbols.txt` (category to symbols, from Apple's list).
    - `nm -u` of the device slice of `libstatglass_mobile.a` and of the app executable, against `fixtures/release/private-symbols.txt` (`_IOReport*`, `_IOHIDEventSystemClient*`, `_IOHIDServiceClient*`, `_NStat*`, `_SMC*`, any `_IOService*`, `_task_for_pid`; each line with its reason).
    - `otool -L` load commands: only `/System/Library/Frameworks`, `/usr/lib` and `@rpath` inside the bundle.
    - `strings` matches for `PrivateFrameworks` and the IOReport text, reported but not failing.
    - `xcrun assetutil --info` showing AppIcon, and the source icon's hash differing from the placeholder.
    - `codesign -d --entitlements` with no `get-task-allow`.
    - No `expo-dev-client` or dev-menu frameworks, and `main.jsbundle` present.
    - `hermes` signature reported.
  - **Simulator runs** (a Release build for `iphonesimulator`, following `.claude/skills/ios-simulator/`):
    - First launch, with a cold install and no hosts: welcome within 3 s, no crash, the reviewer path, `log stream --predicate 'subsystem == "app.statglass"'` with no dial.
    - An iPad simulator in compatibility mode.
    - The iPhone Duo closed and open postures, if available.
    - Light, dark and AX1.
    - Five demo screenshots at 1206x2622 with `simctl status_bar override`, in `apps/mobile/dist/store/` (gitignored).
  - **IPv6 locally:** lane e's `[::1]` test, plus `make ssh-docker-test` with the container reached on an IPv6 address if the Docker runtime gives one (else say so). NAT64 itself needs a device on a Mac's NAT64 Internet Sharing network, which is in the checklist.
  - **`.github/releasing-mobile.md`** holds the runbook and the user's checklist:
    - **App Store Connect record:** name, bundle id `com.tryopendata.statglass.mobile`, SKU, category.
    - **URLs:** privacy policy and support.
    - **App Privacy:** Data Not Collected.
    - **Export compliance:** the D-entry's answers, and the French declaration if chosen.
    - **Ratings and labels:** the age rating questionnaire, and the Accessibility Nutrition Labels (voluntary) after an Accessibility Inspector audit of welcome, hosts list, host, one module page and Settings.
    - **Screenshots:** the iPhone set (and Duo from April 2027 on SDK 27.1+).
    - **Review notes text:**
      - There is no account.
      - Tap "Try demo hosts" on the first screen; the demo hosts are simulated and show every feature.
      - Real use pairs with StatGlass on a Mac or `statglass-agent` on Linux by scanning a QR code that expires in minutes, so no sample code can be attached.
      - The camera is used only to scan that code. Local Network is asked only when connecting to a host on the same network. Face ID is the optional App Lock.
      - Nothing is sent to the developer.
    - **Device checks:** TestFlight on a device for the camera scanner, the Local Network prompt and `local_network` error, and the Secure Enclave key; the NAT64 Internet Sharing test.
    - **Upload:** Validate App in Organizer, then the upload (Organizer or Transporter); the user's step.
    - **After approval:** add the build to `compat/mobile-protocol.json`.
- **Decisions already made:** local only; no EAS; no upload from scripts; checks fail on symbols, not strings.
- **Out of scope:** submission, App Store Connect API calls, hosted CI.
- **Done when:** the table's Done-when conditions are met.

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
- 2026-11-24: phase 3/5 scaffolds landed (9b312222, 8a2ce900; merge 7d8d8f5a). Corrections to the plan found against the code: `AgentInstallError` also needed `agent_install_error` at `setup/linux.rs` (4 sites) and `update_controls.rs` (3); `classifyFailure` in `remote-connection.ts` has no default, so both new failure kinds got explicit cases; `PairReply::Error(PairError)` fails to decode under `tag = "kind"`, so it is `Error { error: PairError }`; session `pair` takes no `pairing_key` (it would make session depend on statglass-ssh), the dialer carries the signer. Stubs to fill: `MirrorPolicy::phone` returns desktop values (phase 3 lane sets the 25 MB / 250 MB caps), `history_recent` has a `Covered` stub arm, the ipc phase-3 gate test is ignored until lane b. Placement: run options in `statglass-session/src/source/policy.rs`; ipc services gated `cfg(all(unix, not(target_os = "ios")))`; agent pairing commands grouped as `Command::Device(DeviceCommand)` with no CLI tests yet (phase 5 lane owning the agent adds them); mock event subscriptions moved to `packages/core/src/mock/emitters.ts`. `make ssh-docker-test` was not run on the scaffold; run.sh's restricted and pair entries run only once their test files exist. Lane a should diff ipc with `git diff -B -M` to see the moves.
- 2026-11-24: phase 6 lane c review (4 findings, all accepted): desktop MirrorBars down bars lost `bg-(--a)` for an inline style (output drift); desktop MeterTrack became a wrapper (double instances on the 1 Hz path); mobile BarFill silently paints grey with no accent in scope instead of throwing, and no test checks per-scheme accent colors; battery charge meter uses the thin track where desktop uses `h-1.5`. Lane c's `(except types.ts)` ownership note confuses check-lane; its types.ts change is the three approved prop additions. Phase 3 lanes a, b, c started from c365eba2.
- 2026-11-24: lane 3b q1/q2: RFC 4.4 keeps S10 off the phone except transient recent rows while connected, so the brief's 'recent uses the finest tier kept' is wrong for recent; Mirror::recent keeps accepting S10 recent replies, never synced or retained; recent_watermark stays the durable S10 end (None on the phone, so it requests the full five-minute window). Lane c must establish the mirror epoch via the cursor before an early RecentRequest. Lane 3a: src-tauri lib.rs and history.rs added for module and import cleanup. Lane 3c: network_changed() stays for the desktop as a delegate to network_changed_with(net). Phase 6 integration: lanes a/d tested against the null twin; a shared Reanimated stub (89c8344a) replaces the bundled mock, which throws under jest-expo.
- 2026-11-24: lane 3b review (2 findings): accepted Covered treating never-synced M1 as covered (fresh phone mirror has no prune mark), fixed with a min(bucket_ts) check; rejected a Covered-aware tier_for, whose only caller is the desktop's Auto query path.
- 2026-11-24: lane 3a review (3 findings, all accepted): no desktop test pinned TierRequest::Auto -> TierChoice::Auto; production code between two test modules in ipc process.rs with the app_quit rationale dropped; two stale doc references (one doc-only bindings change approved). Lane 5b q1: p256 added to statglass-remote (same pin); explicit RemoteError::Pairing(PairingRefusal { Denied, Expired, Rejected(PairError) }) mapped to CommandError::Pairing, so the phone can tell a decline from an expiry; run_forced keeps its signature and ends on disconnect or Expired.
- 2026-11-24: lane 3c review (5 findings, all accepted): probe deadline slides on repeated path events while heartbeats are off; lan_up misses public and CGNAT v4 and counts hotspot/VM bridges (decision: public and CGNAT v4 on a physical interface count as LAN, superseding 'private v4'); synchronous SQLite on the injected runtime; resume() and a retry during a dial tear down healthy sessions; any known network change aborted an in-flight write.
- 2026-11-24: phase 6 integration merged (motion tokens generated from desktop motion.css, zeroed under Reduce Motion or Low Power Mode; demo ticks at 1 Hz). Lane 3c review fixes merged (5 accepted). Phase 3 gate: make check passes except updater-patch-test, which cannot run from a worktree nested in the main checkout (Cargo finds the outer workspace); the branch does not touch vendor/. Lane 5a q1: expiry-time is YYYYMMDDHHMMSS in the host's local time without Z (the Z suffix needs OpenSSH 9.1, per its release notes; 7.7 minimum stands), the pair nonce check stays authoritative; p256 granted to statglass-remote (same pin as 5b) and one helper integration test file.
- 2026-11-24: lane 5b q3: granted a relay-generated attempt ID on ControlRequest::PairStart (local socket only; phone CBOR unchanged) so a timed-out PairStart retry gets the committed result while a second connection still gets Used; lane 5c must call the attempt-aware entry point. Granted a getifaddrs accessor in statglass-session network.rs, reached by the agent through statglass-remote pairing.rs (no new crate edge), replacing hostname -I. Tokio process in statglass-ssh dev-deps. Linux discovery assumes the stock sshd port and /etc/ssh host keys (follow-up: custom sshd config).
- 2026-11-24: lane 5a q2: the helper expired-nonce regression (pair refuses an expired nonce even while sshd's local-time expiry still admits the line) moves to lane 5c, since pair::run is a stub until lane b lands.
- 2026-11-24: phase 6 simulator QA (iPhone 18 Pro, demo, light and dark): host detail ticks at 1 Hz; an offline remote holds dimmed last readings; dark host screen matches the desktop popover in card order, accents, headlines and legends (difference left: phone sub-values regular vs desktop semibold, type differences allowed by RFC 4.6). Found: the hosts list shows identical static vitals for every demo host (mock hosts-dashboard fixture, desktop same); list says 'Offline' where detail says 'Offline since'; a gap between seeded history and live start in demo charts; demo has no path to pairing or out of demo, so the pairing back-out check moves to phase 7 QA. Reduce Motion / Low Power toggles not drivable in the simulator tool; covered by motion.test.tsx.
- 2026-11-24: lane 5a review (2 findings, both accepted): pairing expiry used the process TZ (jiff try_system) while sshd reads /etc/localtime, so a shell TZ differing from the system zone could write an already-expired line; the device last-seen JSONL log grew without bound (compact past 64 KiB under the lock, skip when held). Owns widened for the granted Cargo.lock, statglass-remote Cargo.toml and helper tests/restricted.rs.
- 2026-11-24: lane 5b done (6d0b940e). Owns widened for its granted edits; Cargo.lock, statglass-remote Cargo.toml (same p256 pin as 5a) and the server.rs scaffold arm stay with lanes 5a and 5c in the table and are recorded here as grants to 5b. docker_pair needs 5a's add_pairing, so it runs after both merge.
- 2026-11-24: lane 5b review (4 findings, all accepted; no security break): relay gave up on control transport errors after an accepted start while the host stayed Pending (fix: bounded retry plus a local PairAbandon); agent error/Ctrl-C paths reached the phone as Unavailable instead of Denied; SIGHUP/SIGTERM left the pairing line and socket; a wedged host kept the forced pair process alive ~71 min (watch phone stdin, bound by the offer's expiry). Moved to lane 5c: prune expired statglass-pairing lines in DeviceKeys, wire PairAbandon in the Mac server.rs arm, and the expired-nonce helper regression.
- 2026-11-24: phase 4 scaffold (36dcbc94) and lane briefs written. Four lanes: the Rust facade is split along a scaffold-owned `SessionControl` trait into sessions (a) and lifecycle, policy and signer (d). New edges are statglass-mobile on session, ipc and ssh; the core owns its own tokio runtime, since UniFFI's tokio feature would add async-compat. Facade types live in `statglass_ipc::mobile` so the one specta exporter types them. statglass-ssh gains `authorized_key_line` for a bare SEC1 point. A `@native/*` alias exists because Biome bans `../` in the app. Placement of the cross-cutting items: native snapshot cover in lane b, lock-gated (RFC 3.8); cellular SyncPolicy and the 250 MB total (`min(25, 250 / n)`) in lane d; resume and quiesce, Rust side in lane d and Swift wiring in lane b; the About protocol range in lane c. Deferred: RFC 4.4's 7-day cap on the first M15 sync over cellular (it needs a session floor override), and `liveOnCellular`, the cap of 8 sessions and rotation (all phase 7).
- 2026-11-24: 4/d merged. Granted the p256 dev-dependency in statglass-mobile (Cargo.toml, Cargo.lock) to verify signatures in tests; check-lane's manifest rule flags it by design, merged on the explicit grant. Lane review: accepted signer key cache (cache only a valid point), sync_policy returns None on unsatisfied paths, backgrounded() reader (temporary cfg_attr expect until integration calls it); rejected the Cargo scope finding (granted). The RFC 3.1 Low Data / cellular row says Summary-only; the plan table (constrained or cellular-sync-off = Off, cellular-sync-on = SummaryOnly) is the decision, and the RFC row needs the same wording. Integration owes: MobileConfig.data into Lifecycle at start, gating sources added while backgrounded.
- 2026-11-24: Granted lane 4c StatglassNative.types.ts (InstanceType extends for Expo 58.1's constructor-typed NativeModule) and apps/mobile/tsconfig.node.json (@native/* path); granted lane 4b the snapshot-setting settings screen for a synchronous native cover set. The data-directory startup failure stays a standard Expo rejection; integration narrows the types doc.
- 2026-11-24: 4/c merged. Lane review: accepted event-callback throws, callCore rejections, debug host left connected, throwing version(); rejected the scope finding on the two granted type files (Owns widened).
- 2026-11-24: 4/a merged (base for its fixes was landing 6e0c9b21, merged into the lane). Lane review: all five accepted (per-frame host events, live streams dropped on rebuild, failed hosts unlisted, wall-clock test, missing budget-rebuild test). Integration: MobileCore::quiesce is synchronous (requests issued before return) with async quiesced(); start passes MobileConfig.data to Lifecycle. Follow-up: sources added by set_hosts while backgrounded are not parked (JS is suspended in the background, so rare); HostInfo from the peer Hello is not exposed.
- 2026-11-24: 5/c merged. Granted the four authorized_keys and pairing-test files (owned by merged lane 5a; the validator rejects a second owner, so check-lane flags them) for expired-line pruning and the expired-nonce regression. Lane review: confirmed only an explicit Mac Approve on a pending offer installs a device line; accepted offers surviving app quit, monitoring-off shown as a denial, and the expired-nonce test not reaching its case. Follow-ups: revoke leaves an already-open stream connected (the confirm says so); the approval code is the Mac's own offer code read from the QR, so it cannot tell a phone that scanned a photo of the screen apart (a design question for the RFC, raised to the user).
- 2026-11-24: 4/b merged (base for its last turn was landing 5e2bfef2, merged into the lane). Lane review: accepted DerivedData leak in native-check, resume waiting on quiesce, start reading the key, teardown leaving the core alive; rejected the app-lock-setting scope finding (granted). The lane's first ordering fix drove UniFFI future-polling internals; replaced by the facade's synchronous quiesce() plus async quiesced().
- 2026-11-24: Phase 4 demo ran against the ssh-docker OpenSSH container (Linux statglass-agent on its default socket, helper path /usr/local/bin/statglass-agent) instead of this Mac: adding the phone's key to ~/.ssh/authorized_keys and turning on Remote Login change the user's security settings, which the run does not do. Same russh session, simulator key (Keychain), pinned ed25519 host key. Debug screen went Disconnected to Live; CPU tracked a 2-of-16-core load (0% to 9%); the session came back Live after HOME and relaunch; About shows core 0.14.0 and protocol 1. Gate on HEAD: mobile-check 192 tests, mobile-native-check simulator build passed; Rust/frontend/Docker gate from phase 5 unchanged by 4b (Swift/TS only).
- 2026-11-24: Final review, split three ways (host crates; mobile core and app; Mac shell and shared core). Accepted 20 of 21. Host: Linux pairing read HOME/USER from the environment, so `sudo -E statglass-agent pair` edited the invoking user's authorized_keys as root and bundled login `root` (fix: passwd entry of the euid); pairing refusals collapsed into one CommandError string (fix: typed `PairingFailure`); unused `start_attempt`/test-only `start`/root re-export of unbound `run_forced`; authorized_keys.rs and agent pair.rs at the size ceiling (splits); stray pairing re-exports and missing docs. Rejected: replacing the authorized_keys key-blob/base64/fingerprint code with `ssh-key` during review (different parser in a security path; follow-up). Mac shell: duplicated offer state in src-tauri (moved into PairingHost), wildcard ControlRequest arm, stale stub docs, `pairing_deny` returning `()` (two-call race), misplaced core copy and its tests, mock pairing reading `this`/`Date.now()`, undocumented selectors. Mobile: Swift never produced the typed `ERR_STATGLASS_*` errors TS parses, phone settings never reached the debug core, blocking SetHosts/AuthorizedKeyLine on tokio workers, sync policy held in four places, no test of foreground during a budget rebuild, missing-listener log once per lifetime, DemoLifetime logic in the root layout, missing docs. Fixes run as foreman ios-fin-host, ios-fin-mcore, ios-fin-mapp.
- 2026-11-24: Final review fixes merged (ios-fin-mcore, ios-fin-mapp, ios-fin-host). Fix review: all 25 findings fixed, no regressions (checked pairing single use after `used` became `attempt`, cancel_open/withdraw_if_open against the old shell on monitoring-off and shutdown, registry policy default Full, duplicate start now `internal`). Combined gate on landing: 950 Rust tests, 2834 frontend, 194 mobile, bindings, rust-check, architecture-check, mobile-rust-check, ssh-docker-test (pairing over sshd, mobile sessions), mobile-native-check. Follow-up: replace authorized_keys key encoding with `ssh-key` behind a cross-check test.
- 2026-11-25: Run reopened at the user's request for phases 7 and 8 (briefs written in full) and a new phase 9, design and UX parity with the macOS app. Why: a simulator design audit (items 1 to 21 and 18b: an empty large-title band giving massive top padding on the host screen, native headers that ignore the theme, top nav buttons off the design system, weight-700 titles, card type far above RFC 1.4's mapping, identical demo values, a bare module page) and the user's notes since: module pages at dashboard visualization parity with a live read-only process table on every page and no investigation features; three accent charts per hosts-list row; Settings > Hosts rebuilt with iOS list conventions, swipe-to-delete and drag reorder; the welcome screen as the front door with first-run, restore and empty states. Because those items are too many to go straight to lanes, phase 9 is a stub until `plan/rfc-ios-polish.md` is reviewed (devil's advocate) and its lanes are written here.
- 2026-11-25: User decision: one OS-neutral pairing flow. "Pair with your Mac" and "Add a Linux server" become one "Add a host" (RFC 1.3 and 2.4 wording), scan or paste; `pair-linux.tsx` is deleted; handing over a Mac's other hosts is a payload capability (`can_hand_over`), never an OS check. Phase 7 lane c writes the D-entry in `plan/decisions.md`.
- 2026-11-25: User requirement: screen-scoped data demand (phase 7 lane e). The app pulls only while foregrounded and a hosts list, host or module screen is focused; Settings, pairing, onboarding and debug pull nothing; no background modes. Lane e also closes the 4/a follow-up (sources added while backgrounded are not parked).
- 2026-11-25: Assumption changed: the phase 7 and 8 live checks use the ssh-docker Linux agent, not this Mac with Remote Login (the orchestrator may not turn on Remote Login or edit `~/.ssh/authorized_keys`).
- 2026-11-25: Restructured at the user's request after three audits (architecture, error handling, tests; scratchpad `audit-architecture.md`, `audit-errors.md`, `audit-tests.md`). A foundation phase lands first as phase 7: one native-core owner (F1), shared card content models (F2), one live-session policy (F3), a navigator theme (F4), boundary lint rules, transport-scoped query keys, one connection-status wording, Rust logging and typed open errors, vitals age, typed native errors, an error boundary and route guard, FakeNative-only tests and error fixtures in the mock, and the host-served `NetworkAddresses` query (the user's Network decision; a one-way door with its D-entry). Pairing moves to phase 8 (its connection-state lane moved into phase 7 lane f, its incompatible-side work into phase 7 lane d), handover to phase 9, polish to phase 10 onward. A separate phase rather than the pairing scaffold, because the audit fixes touch the files pairing's lanes own and fan out as eight disjoint lanes. Audit items not in phase 7 are placed or deferred in `plan/rfc-ios-polish.md` section 9.
- 2026-11-25: User question on data pull: phase 8 lane d now specifies that compact (hosts-list) demand runs without `Live1s` (a `HostSummary` every 5 s plus one 30-minute `RecentRequest`, which cannot be scoped to three series), full demand subscribes `Live1s`, process interest only while a live process table is on screen, and no session after `PARK_GRACE`. Bytes per second at each level are measured against the Docker agent in that lane and recorded here.
- 2026-11-25: The user decided the phone keeps no persistent history (D-152), reversing `plan/rfc-ios-app.md`'s mirror design (4.4, D-146) at the user's request; a note at the top of that RFC points to the change and its body is unchanged. The host answers a new bounded `Query::History` (series, range, point budget, module events, stats in one answer; limits `HISTORY_MAX_POINTS` 500, `HISTORY_MAX_SERIES` 32, `HISTORY_MAX_ANSWER_BYTES` 512 KiB; coarsest tier that covers the budget, persisted rows only; one query per session, two host-wide, `Busy` beyond, a 10 s cache). Phase 7 gains lanes i (phone core without a mirror), j (host history query), k (phone history data, the one cellular switch) and l (logging and the facade test, split from lane d); lane d keeps the session and IPC error work and removes the phone-only `SyncPolicy`/`MirrorPolicy::phone`. The shared wire files moved from lane h to the scaffold. D-152 and D-153 (network addresses) written before any codec change. Offline hosts show dashes and "Offline since", never last readings. The user confirmed a 5 s hosts-list update is fine, so `HostSummary` stays at 5 s with no wire change; the RFC's open question on it is dropped. Phase 8 lane d now also measures history bytes and agent CPU per query (1 h, 24 h, 7 d, 30 d) and during 30 s of range flipping; results go here when run.
- 2026-11-25: devil's-advocate review of phases 7 to 12, the polish RFC and D-152/D-153, applied. History answers now reach now through the hub's bounded recent rows (`history_through_now`, never the raw ring); events travel as `WireEvent` and `PublicIp`/`HistoryClamp` gain `Unknown` through `Tagged`/`lenient`; the per-session queue replaces only a same-chart query and 3 `Busy` answers end in the chart's load error; the reader gains a layout filter and the row bounds count the M15 read's `tier_1m` union; stats are per series key; hosts-list rows use `net.rx_total`/`net.tx_total`; the CPU heatmap is its own query with a 256-series per-core clamp; an unknown selector is `InvalidArgument`, a known one without data returns gaps. Lane j splits into j1 (read path) and j2 (concurrency, with the limits on `HostServer`); the scaffold cuts the phone's mirror calls so lanes d and i have no merge order, adds `SubscriptionInfo.recent_ms`, `MobileCall::SetProcessInterest` (implemented by 8d) and the facade test seam, removes the phone's dead `SetHostsRecentInterest`, and switches every TS caller to `hostHistory`; lane l's facade test runs over a scripted dialer, and the real end-to-end check is lane i's Docker test; seeds go by retention, with `serve.sh --seed` for the container (8b). The user then decided every host looks up its own public IP (24 h cache, early on a network change, 10 min after a failure, on demand only, no switch) and that the Mac shows addresses for remote hosts (new phase 8 lane e). Phase 11 depends on phase 9.
- 2026-11-25: Phases 10 to 12 written from the accepted `plan/rfc-ios-polish.md`: phase 10 primitives (lanes a-e; the scaffold does the text variants, the `variant` rename with a `role` alias kept until phase 11 because phase 9 runs beside it, and installs `expo-localization`, `expo-symbols` (the RFC names it as the icon source but its scaffold list omitted it) and `react-native-reorderable-list`), phase 11 surfaces (lanes a, b, c1, c2, d, e; the RFC's lane c split in two because the host screen and the cards together were larger than L), phase 12 module pages (lanes a-c). Settings joins the root stack (architecture I6). The annotation layout model already exists in core (`widget-models/chart-annotation.ts`, with rows and "+N"), so lane 11e only renders pills in a band above the plot.
- 2026-11-25: Phase 13 (App Store readiness) written at the user's request, after a requirements pass over Apple's and Expo's primary docs and an audit of `apps/mobile` with a scratch-copy prebuild (deleted). Blocking: Expo's blank placeholder icon, no privacy manifest (the Rust staticlib imports `stat`/`statfs` and has none of its own), version 0.0.0 with a fixed build number, no in-app privacy policy link, no export compliance answer, plus phase 8's camera plugin bringing an unused generic microphone string. Six lanes (a M, b S, c M, d S, e S, v L); the user answers iPad, export compliance, privacy page hosting, name and category, and review access before the scaffold. `plan/rfc-ios-polish.md` section 9 moves arch I8 to this phase.
- 2026-11-25: phase 13 user decisions: ITSAppUsesNonExemptEncryption true, answered as standard algorithms (the SSH crypto is non-Apple; France declaration or exclusion handled in App Store Connect); iPhone only, checked in iPad compatibility mode; privacy policy and support at docs-site /docs/iphone; name StatGlass, Utilities with Developer Tools secondary; review access through demo mode only. Linux-only setup (polish open question 1): the welcome screen links the README section and says a Mac is needed.
