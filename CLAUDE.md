# StatGlass

Open-source macOS system monitor. A menu-bar tray plus popover, a dashboard window, and
(v2) desktop widget boards, showing CPU, GPU, memory, power and sensors, network, disk and
battery at 1 Hz with local history. Tauri 2 + Rust engine, React UI. StatGlass for iPhone
(`apps/mobile`, in progress) is a read-only Expo viewer of the same hosts over SSH, reusing
the Rust session code and `@statglass/core` (`plan/rfc-ios-app.md`).

## Development Phase

**Pre-v1.** Breaking changes are encouraged if the result is cleaner. Don't waste time on
deprecation warnings, backwards compatibility, or migration paths. The exceptions are the
one-way doors in `plan/architecture.md` (series data model, host identity, wire format):
get those right, don't iterate on them casually.

## Start here

- `plan/README.md`: what is being built and how the plan is organized
- `plan/PROGRESS.md`: what is done, in progress, and next. Update it when you finish a task
- `plan/design-system.md`: tokens, module accents, type, surfaces, component inventory

**Every UI feature is checked against the design system and the screens already built
before it is called done.** Read `plan/design-system.md` and look at the neighboring screens
before building, screenshot the result (browser dev server + mock transport, plus the dev
gallery at `/?route=/dev/gallery`), and compare. Name every difference you leave in place and why.

## Architecture

```
crates/                    Rust workspace
  statglass-schema/           metric catalog, series keys, HostInfo, Capabilities, Snapshot view
  statglass-proto/            framing, CBOR codec, handshake, message types
  statglass-collect/          Collector trait; macos/ (sysinfo, IOReport, SMC/HID, IOKit); linux/ (/proc, sysfs, cgroups)
  statglass-store/            SQLite: series interning, tiered rollups, gaps, cursors, pruning
  statglass-engine/           sampler loop, rollups, detectors, bus, history lifecycle and queries
  statglass-session/          client session: Endpoint, Dialer seam, handshake and route race, RemoteError (no process spawning)
  statglass-ssh/              russh dialer with the Signer seam (Secure Enclave on the phone)
  statglass-remote/           OpenSSH dialer, controller management, protocol server, isolated history mirrors
  statglass-remote-helper/    bundled stdio-to-local-socket bridge
  statglass-mobile/           iPhone app's UniFFI facade (staticlib -> XCFramework); never depends on statglass-remote
  statglass-ipc/              planned: IPC types both apps use, live producer, CommandError
src-tauri/                 app shell: HostRegistry, LocalSource, settings owner, tray, windows, commands
src/
  app/                     desktop React (~ ~/): routes/<route>/{_components,_hooks,_lib}, components/{ui,charts}, widgets/, hooks/
  desktop-transport/       Tauri adapters (~ @desktop/): native*.ts, app-transport.ts, commands.ts (generated)
packages/
  core/src/                @statglass/core (~ @core/), shared by both apps: transport contract, mock, formatters, chart math
    generated/types.ts     tauri-specta types and constants. Generated, never hand-edit
apps/
  mobile/                  Expo app: src/app routes, src/hooks, src/widgets, src/transport, modules/statglass-native (Swift)
scripts/mobile/            mobile checks, iOS Rust check, XCFramework build
plan/                      planning docs (owned by the planning process; read, don't restructure)
```

**Critical rules:**

- Crate dependencies follow `scripts/architecture/crate-edges.json`, checked against Cargo metadata by `make architecture-check`. See `.claude/rules/rust/crates.md` for ownership.
- `packages/core/src/` has no React, React Native, Expo, `@tauri-apps/*` or DOM globals; it is shared with the iPhone app.
  `src/app/widgets/**` is render-only: props in, no transport, stores, router or `@tauri-apps/*`.
  `apps/mobile/` never imports `react-dom`, `@tauri-apps/*`, `@desktop/*` or the desktop app.
  Biome (`noRestrictedImports` overrides) and a write hook enforce all three.
- Code moves into `packages/` only with its second consumer, and a shared model that needs a platform option is forked, not flagged (`rules/shared-packages.md`).
- Rust types are the single source of truth for IPC. Regenerate `packages/core/src/generated/types.ts` and
  `src/desktop-transport/commands.ts` with `make bindings`, never edit them.
- Neither frontend calls its platform directly; everything goes through the `@core/transport` contract. The desktop
  implements it with Tauri Channels in `src/desktop-transport/`, the phone with `MobileTransport` over the
  `statglass-native` module, and a mock serves the browser dev server, Vitest, Playwright, jest-expo and demo mode.
- Storage and sync work on series (`metric_id` + labels). Gaps are explicit; never interpolate.
- The idle-CPU budget (under 0.5% across app + WebKit helpers) covers the backgrounded app: menu bar only, no popover or dashboard. Visible UI has no product budget but is regression-gated (D-088). Every 1 Hz render path still matters.

## Rules index

Rules in `.claude/rules/` attach automatically by path. Read one directly when you need it.

| Rule | Covers |
| ---- | ------ |
| `rules/data-boundary.md` | Rust owns what data means (periods, gaps, semantics); the client only does view-dependent shaping |
| `rules/frontend/react.md` | Two-layer structure, aliases, typed IPC, scoped zustand stores, 1 Hz selectors, widget boundary |
| `rules/frontend/styling.md` | Tailwind v4 ladder, tokens, module accents, 1 Hz rendering stability |
| `rules/frontend/motion.md` | Motion tokens, streaming-chart motion, reduced motion, idle-CPU cost |
| `rules/frontend/error-handling.md` | Typed command results, gaps vs errors, channel failures |
| `rules/frontend/testing.md` | Mock transport, Playwright against the dev server, render-count tests |
| `rules/shared-packages.md` | What both apps share, the seven guards (pull never push, fork not flag), pure widget models |
| `rules/mobile/expo.md` | Expo app structure, thin routes over core hooks, one QueryClient, NativeWind tokens, safe areas, 44 pt, Dynamic Type, VoiceOver |
| `rules/mobile/native-module.md` | Swift module is a pipe, non-blocking lifecycle, Secure Enclave and simulator signers, generated UniFFI code |
| `rules/mobile/testing.md` | jest-expo on Node, real providers, shared mock fixtures, simulator screenshots |
| `rules/rust/crates.md` | Crate boundaries and ownership, zero runtime deps, series data model |
| `rules/rust/error-handling.md` | thiserror/anyhow split, `CommandError` mapping, no unwrap, poison-safe locks, ticks never panic |
| `rules/rust/platform.md` | Private-API isolation, unsafe FFI, cfg gating, Linux portability |
| `rules/rust/lints.md` | fmt, clippy, function and file size limits (D-112) |
| `rules/rust/testing.md` | Test placement, codec skew tests, hardware-only tests |
| `rules/rust/mobile.md` | `statglass-mobile` facade: JSON result shape, `catch_unwind`, no `statglass-remote`, iOS cfg gating, russh pin |
| `rules/generated-bindings.md` | tauri-specta output is generated; how to regenerate |
| `rules/testing.md` | Scoped-run ladder, mocking boundaries, timing fakes, flake triage |
| `rules/verification.md` | What "done" means: suites, screenshot comparison, measured perf claims |

Skills: `frontend-design-slop` before adding headers, card grids, badges or stat tiles;
`ios-simulator` to check a mobile screen in the simulator against the desktop popover;
`mobile-bridge` to change what the phone asks Rust for, facade to `MobileTransport`;
`widget-model` to extract a widget's model into `packages/core` and build its native twin.
Delegated runs (foreman, Codex) get the contract items in `.claude/delegate.md`.

### Shared personal plugin skills

`ce:architecting-systems` (module boundaries and system design) and
`ce:planning-products` (feature scope and experience) are Claude Essentials skills.
Their shared directory names are `architecting-systems` and `planning-products`;
the skill metadata retains the `ce:` names. Share each whole skill directory
through a symlink in `~/.agents/skills/`; keep the source
and its relative `references/` together rather than copying instructions.

If a requested `ce:` skill is absent from the session catalog, first look for
`~/.claude/plugins/marketplaces/claude-essentials/plugins/ce/skills/<name>/SKILL.md`,
then search the installed `~/.claude/plugins/cache/claude-essentials/ce/` versions.
Read the matching skill and its relevant references. Do not assume an absent
catalog entry means it is uninstalled, and do not install or overwrite skills
just to resolve a lookup. This personal setup is separate from the repository's
generated `.agents/skills` links; see `scripts/agent-config/README.md`.

## Prerequisites

- **Bun** at the version in `package.json`; Node tooling uses `.node-version`.
- **Rust** at the version in `rust-toolchain.toml`, including `rustfmt` and `clippy`.
- **Xcode Command Line Tools** (macOS SDK for the collectors)
- **pre-commit** (via `uvx pre-commit` or `brew install pre-commit`), then `make hooks`. Git hooks run native macOS checks locally; hosted CI uses Linux only

## Hosted runner policy (D-118, D-131)

**The only GitHub-hosted macOS job is the `macos` job in `.github/workflows/release.yml`**,
which runs on a pushed `v*` tag on the standard `macos-26` runner (free on this public
repository) and waits for the maintainer's approval in the `release` environment. Never
add macOS to push/PR CI, preview OS checks or any other workflow, never use a larger
(billed) runner size, and never rerun a historical workflow revision that has other
macOS jobs. Everything else uses Linux runners.

iOS builds, simulator checks and App Store submissions run locally too; no hosted macOS
job is added for the iPhone app. Run native macOS checks locally through the existing Git hooks (`make check
bindings-check e2e-perf` in pre-push). Cut releases with `scripts/release.sh` as
described in `.github/releasing.md`. Do not bypass those hooks. Before dispatching or
rerunning a workflow, inspect the workflow at its target revision. If a running job is
found on a macOS runner outside the release job, cancel it and report it. Changing this
policy requires an explicit new user decision.

## Debugging Budget

If a fix doesn't resolve the issue after 2 attempts without running a new diagnostic step in between, stop. Write "2-attempt limit reached. What I learned: [summary]", list 2-3 alternative root cause hypotheses, and ask which to investigate. Running a new diagnostic step between attempts resets the count, not evidence-based iteration.

## Worktrees

- **Git commands run from the worktree root** with root-relative paths.
- **One plain command per Bash call in isolated worktree sessions.** Claude Code's worktree isolation refuses `cd <worktree> && ...`, loops, and variable assignments wrapped around git or file operations as too complex to verify. The session is already in the worktree: run `git status`, `git add <root-relative path>`, `git commit ...` as separate calls.
- **A fresh worktree needs `bun install`** before hooks, lint or tests work there.
- **Worktrees sharing one `CARGO_TARGET_DIR` cache build-script paths.** A build in one worktree records absolute paths into the shared target (tauri-plugin-updater's permissions, `statglass`'s `build.rs` output), and once that worktree is removed `make rust-check` fails reading them. After removing a worktree that built into a shared target, run `cargo clean -p tauri-plugin-updater -p statglass` with that target.
- **Lifecycle is orchestrator-owned.** Subagents in a worktree commit and push their branch only — never `ExitWorktree`, `git merge`, or `git worktree remove`.

## README media

The README's recordings live on the orphan `assets` branch under `media/`, not on main,
so clones stay small; `scripts/install.sh` clones `--single-branch --branch main` so
installs never fetch them. The README links `raw.githubusercontent.com/steamfield/statglass/assets/media/<name>.webp`.

- **Format:** animated WebP from an MP4 screen recording (GIF exports come out 2 to 3 times larger, and gifsicle/ffmpeg can't shrink them). Needs `brew install webp`; Homebrew's ffmpeg has no WebP encoder, so frames go through `img2webp`:
  ```bash
  ffmpeg -i in.mp4 frames/%04d.png
  img2webp -loop 0 -lossy -q 85 -m 4 -d 42 frames/*.png -o name.webp   # -d = 1000 / fps (42 for 24 fps)
  ```
  q85 is visually lossless on these UI captures; `-min_size` saves ~1% for much longer encodes.
- **Replacing one:** commit the new file to `assets` under the same name; main needs no change. The branch has no pre-commit config, so commit and push there with `PRE_COMMIT_ALLOW_NO_CONFIG=1`. Work in a separate worktree (`git worktree add <dir> assets`) so main's checkout is untouched.
- **Adding one:** commit it to `assets`, then add the image link to `README.md` on main. Retina captures that should render at 1x get an `<img ... width="<half the pixel width>">` tag.

## Quick Commands

```bash
bun run dev                # Full app (tauri dev: Vite on :1420 + Rust)
bun run dev:fast           # Browser only, mock transport
bun run seed               # Quit StatGlass first: replaces the dev build's history with 30 synthetic days (old DB kept beside it)
bun run seed:prod          # Same for the release build's history (com.tryopendata.statglass)
bun run typecheck          # Browser, test and Node tooling TypeScript projects
bun run lint               # Biome lint (includes boundary rules)
bun run format             # Biome format + import/class sorting + safe fixes
bun run test               # Vitest (scope with: bun run test -- <path>)
bun run test:e2e           # Playwright against the dev server + mock transport
bun run check              # biome check + typecheck + test
bun run --cwd apps/mobile dev    # iPhone app: Metro for the simulator build (first build: ios-simulator skill)
bun run --cwd apps/mobile test   # jest-expo (never bun test)
make mobile-check          # mobile lint, tsc, jest, expo export, expo install --check, single-React check
make mobile-rust-check     # statglass-mobile, -session, -ssh cargo check + clippy for aarch64-apple-ios-sim
make check                 # Frontend + Rust: what the pre-push hook runs, with bindings-check and e2e-perf
make architecture-check    # Cargo dependency graph + Rust production file ceilings
make architecture-test     # Positive/negative architecture-rule fixtures
make agent-hooks-test      # Approval, formatting and task-owned cleanup fixtures
make rust-check            # cargo fmt --check + clippy -D warnings
make bindings              # Regenerate packages/core/src/generated/types.ts and src/desktop-transport/commands.ts from Rust
```
