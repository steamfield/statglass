# Plan: GitHub Star Prompt & Feedback Experience

Skill: sprint. Profile: sprint. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/marketplaces/claude-essentials/plugins/ce/shared/scripts/plan_graph.py
Started: 1795325373. Timebox: none. Landing branch: sprint/github-star-and-feedback.
Gate: `bun run check && make rust-check && make architecture-check && cargo test -p statglass-store -p statglass && make bindings-check` (~90s). Filtered tests: `bun run test -- <path>` (frontend), `cargo test -p <crate> <filter>` (Rust). Typecheck: `bun run typecheck` (frontend), `cargo check --workspace --all-targets` (Rust).
Runner: plain commands.
Worktree setup: `ln -sfn /Users/riley/Projects/statglass/node_modules node_modules && mkdir -p dist`.
Suppressions:
Manifests:

## Spec

StatGlass gains a calm, non-intrusive GitHub star hover-card toast for engaged users who have used the app for more than 24 hours, paired with an always-accessible "Have an issue or want a feature? File feedback" flow across the native macOS menu bar, tray right-click menu, dashboard left sidebar, and Settings (with one-click non-PII system diagnostics copy).

In scope:
- Rust-owned star-prompt eligibility and engagement state persisted atomically in `<app_data_dir>/star-prompt.json` (owner-only permissions via `statglass_store::restrict`), seeded for existing users from `history.db` `meta.created_at_ms` (`min(now, created_at_ms)`).
- Eligibility requires strictly more than 24 hours elapsed since `first_seen_at_ms`, at least 3 distinct engaged sessions (dashboard or popover opens spaced at least 5 minutes apart, with disk writes capped once the threshold is reached), no prior star or permanent dismiss, and no active 7-day snooze.
- Single-use 7-day snooze ("Not now"): on first appearance, user can choose "Star on GitHub", "Not now" (snoozes 7 days once), or dismiss (`×`, permanent). After one snooze expires, the second and final appearance offers "Star on GitHub", "Don't ask again", and `×` (both permanent).
- Clicking "Star on GitHub" opens `https://github.com/steamfield/statglass`, persists `starred`, and hides the card permanently.
- Non-intrusive bottom-right floating hover-card toast mounted only in `DashboardLayout` (never in `/popover` or `/onboarding`), with an 8-second calm-moment delay after mount, suppressed while onboarding is incomplete, while a focal remote-connection error notice is shown, while local history is unavailable, or while the native window is hidden.
- Honest, anti-slop StatGlass phrasing: title `"Enjoying StatGlass?"`, body `"StatGlass is free and open source. A star on GitHub helps others discover it."`, primary CTA `"Star on GitHub"`, secondary `"Not now"` / `"Don't ask again"`, close `×`, non-modal `role="status"`, Escape to dismiss, zero focus steal, respecting `--motion-enter`, Reduce Motion, and Performance mode.
- Feedback entry opening `https://github.com/steamfield/statglass/issues` in three places: native macOS top menu bar (`Help` menu when `Show in Dock` / `ActivationPolicy::Regular` is enabled, plus `"Star StatGlass on GitHub…"` which also marks starred), tray right-click menu (`"Send Feedback…"`), and left sidebar bottom action (`"Feedback"` with a `HoverCard` reading `"Have an issue or want a feature? File feedback on GitHub"`).
- Quiet Settings (General panel) rows for `"Feedback & issues"` (with `"Copy system info"` copying app version, macOS version, and chip — zero PII — plus `"File feedback"`) and `"Support StatGlass"` (`"Star on GitHub"` which also persists `starred`).
- `src-tauri/capabilities/default.json` updated to allow `https://github.com/steamfield/statglass` and `https://github.com/steamfield/statglass/issues`.
- Mock transport support (`star-prompt` scenario, `getStarPromptStatus`, `actOnStarPrompt`), Dev Gallery specimen, Vitest/Rust unit tests, and Playwright E2E coverage.

Out of scope:
- Showing any star prompt in the menu-bar popover, onboarding window, or desktop widgets.
- Telemetry, analytics, or network calls to check whether the user actually starred the repo on GitHub.
- Pre-filling GitHub issue query strings with user data (Issues link goes directly to `https://github.com/steamfield/statglass/issues`; diagnostics are opt-in via "Copy system info").
- App Store `SKStoreReviewController` integration (this is the GitHub open-source star prompt).

Assumptions:
- All delegated sprint lanes, plan critique, and final review use Gemini 4 Neon (`antigravity` / `gemini-4-neon`) as requested by the user.
- `DashboardLayout` render-stability test (`route.test.tsx`) must remain green: `<StarPromptHost />` owns its own query and timer state so `DashboardLayout` never re-renders on prompt timer ticks.
- Existing Playwright specs use the `"default"` mock scenario where `eligible: false`, so the prompt never disrupts existing visual or perf gates; the new `"star-prompt"` scenario returns `eligible: true, can_snooze: true` and passes a short delay in tests.
- On macOS in default `Accessory` mode (`show_in_dock: false`), macOS does not display an application top menu bar; installing the custom macOS app menu via `app.set_menu` activates automatically whenever the user enables `Show in Dock`, while the tray menu and dashboard sidebar remain available in both modes.

Error model:
- `StarPromptOwner::open`: a missing or corrupted `star-prompt.json` never blocks launch; corrupted files log a `tracing::warn!` and fall back to fresh state seeded with `history_created_at_ms` and `now_ms`.
- `StarPromptOwner::record_interaction`: best-effort persistence; disk write failures log `tracing::warn!` and never panic or block window open.
- `act_on_star_prompt` command: returns `Result<StarPromptStatus, CommandError>` (`CommandError::SettingsNotSaved` on save failure) so callers can see persistence failures; in the UI, dismissal/star still hides the card optimistically and logs the error without trapping the user.
- `openUrl` failures in frontend actions log via `console.error` and show a quiet Sonner toast (`"Couldn't open link."`) rather than swallowing silently or crashing; native menu opener failures log `tracing::warn!`.
- Clipboard copy failure for diagnostics shows `"Couldn't copy system info."` via `toast(...)`, matching `SensorDumpDialog`.

## Contracts (scaffold commit)

Shared Rust types (`src-tauri/src/star_prompt.rs`, exported to `src/core/generated/bindings.ts` via `make bindings`):
- `pub const GITHUB_REPO_URL: &str = "https://github.com/steamfield/statglass";`
- `pub const GITHUB_ISSUES_URL: &str = "https://github.com/steamfield/statglass/issues";`
- `pub const MIN_ELAPSED_MS: i64 = 24 * 60 * 60 * 1000;`
- `pub const SNOOZE_DURATION_MS: i64 = 7 * 24 * 60 * 60 * 1000;`
- `pub const ENGAGEMENT_COOLDOWN_MS: i64 = 5 * 60 * 1000;`
- `pub const REQUIRED_ENGAGEMENT_SESSIONS: u32 = 3;`
- `pub struct StarPromptStatus { pub eligible: bool, pub can_snooze: bool }`
- `pub enum StarPromptAction { Starred, Dismissed, Snoozed }` (`#[serde(rename_all = "snake_case")]`)
- `pub trait StarPromptStore: Send + Sync` (`load(&self) -> io::Result<Option<String>>`, `save(&self, content: &str) -> Result<(), String>`) and `pub struct FileStarPromptStore` (atomic temp-file + rename + `statglass_store::restrict`)
- `pub struct StarPromptOwner` with `open(dir: &Path, history_created_at_ms: Option<i64>, now_ms: i64) -> Self`, `with_store(store: Box<dyn StarPromptStore>, history_created_at_ms: Option<i64>, now_ms: i64) -> Self`, `status(&self, now_ms: i64) -> StarPromptStatus`, `record_interaction(&self, now_ms: i64)`, `act(&self, action: StarPromptAction, now_ms: i64) -> Result<StarPromptStatus, CommandError>`
- `AppState::star_prompt: StarPromptOwner` wired in `src-tauri/src/state.rs`
- `src-tauri/capabilities/default.json` adds `https://github.com/steamfield/statglass` and `https://github.com/steamfield/statglass/issues` to `opener:allow-open-url`
- Tauri commands: `get_star_prompt_status(state: State<'_, AppState>) -> StarPromptStatus`, `act_on_star_prompt(action: StarPromptAction, state: State<'_, AppState>) -> Result<StarPromptStatus, CommandError>`

Store contract (`crates/statglass-store/src/reader/inventory.rs`):
- `Reader::created_at_ms(&self) -> Result<Option<i64>>` reads `meta.created_at_ms` from SQLite.

Frontend transport contract (`src/core/transport/contracts.ts`, `native.ts`, `mock/shell.ts`, `mock/fixtures.ts`):
- `getStarPromptStatus(): Promise<StarPromptStatus>`
- `actOnStarPrompt(action: StarPromptAction): Promise<CommandResult<StarPromptStatus>>`
- Mock scenario `"star-prompt"` in `SCENARIOS` / `ScenarioFlags` (`starPrompt: boolean`).

Frontend core contract (`src/core/star-prompt.ts`):
- `GITHUB_REPO_URL`, `GITHUB_ISSUES_URL`, `STAR_PROMPT_DELAY_MS = 8_000`
- `export interface StarPromptGuardInput { status: StarPromptStatus | null | undefined; onboardingCompleted: boolean; hasFocalNotice: boolean; historyAvailable: boolean; windowVisible: boolean; delayElapsed: boolean; }`
- `export function shouldShowStarPrompt(input: StarPromptGuardInput): boolean`
- `export interface SystemDiagnosticsInput { appVersion: string; osVersion: string | null | undefined; chip: string | null | undefined; model: string | null | undefined; }`
- `export function formatSystemDiagnostics(input: SystemDiagnosticsInput): string`

UI component contracts:
- `src/app/components/star-prompt-card.tsx`: `StarPromptCard({ canSnooze, onStar, onSnooze, onDismiss, className? })`
- `src/app/routes/dashboard/_components/star-prompt-host.tsx`: `StarPromptHost({ hasFocalNotice, delayMs? })`

Layout:

    crates/statglass-store/src/reader/
      inventory.rs                                   adds Reader::created_at_ms (implemented in scaffold)
    src-tauri/src/
      star_prompt.rs                                 star-prompt state machine, persistence, and Tauri commands
      app_menu.rs                                    (Phase 2) macOS top menu bar with Help -> Feedback & Star items
      lib.rs                                         wiring only: registers commands and (Phase 2) installs app_menu
      state.rs                                       wiring only: holds StarPromptOwner on AppState
      windows.rs                                     wiring only: records dashboard-open engagement
      popover/panel.rs                               wiring only: records popover-open engagement
      tray/mod.rs                                    (Phase 2) adds Send Feedback item to tray right-click menu
    src-tauri/capabilities/
      default.json                                   allows opening GitHub repo and issues URLs (wired in scaffold)
    src/core/
      star-prompt.ts                                 pure constants, calm-moment eligibility predicate, diagnostics formatter
      transport/contracts.ts                         adds getStarPromptStatus and actOnStarPrompt to Transport
      transport/native.ts                            wires Tauri commands for star prompt
      mock/shell.ts                                  mocks getStarPromptStatus and actOnStarPrompt with stateful transitions
      mock/fixtures.ts                               adds "star-prompt" scenario flag
    src/app/components/
      star-prompt-card.tsx                           presentational bottom-right hover-card toast UI
      sidebar.tsx                                    (Phase 2) supports quiet bottom external-action footer slot
    src/app/routes/dashboard/
      route.tsx                                      mounts <StarPromptHost /> in DashboardLayout
      _components/star-prompt-host.tsx               fetches status, applies calm-moment delay/guards, dispatches actions
      _components/live-sidebar.tsx                   (Phase 2) passes Feedback button + HoverCard into Sidebar
      settings/_components/general-panel.tsx         (Phase 2) adds quiet Feedback/Diagnostics and Star rows
    src/app/routes/dev/gallery/_sections/
      app-components.tsx                             (Phase 2) adds StarPromptCard specimen to gallery
    tests/e2e/
      star-prompt-and-feedback.spec.ts               (Phase 2) Playwright E2E for star prompt, popover exclusion, feedback, settings

## Phases

### Phase 1: GitHub star hover-card toast (MVP)

Demo: `bun run dev:fast` and open `http://localhost:1420/?route=/dashboard/overview&scenario=star-prompt` to see the floating GitHub Star hover-card appear in the bottom-right corner; click "Star on GitHub", "Not now", or Dismiss `×`, and open `http://localhost:1420/?route=/popover&scenario=star-prompt` to confirm it never renders in the tray popover.
Test cases:
- Rust `star_prompt`: fresh install sets `first_seen_at_ms = now`, `eligible = false` at 0h and at exactly 24h (`MIN_ELAPSED_MS`), `eligible = false` at 24h+1ms with fewer than 3 engaged sessions.
- Rust `star_prompt`: existing user with `history_created_at_ms` >24h ago seeds `first_seen_at_ms = history_created_at_ms` (and ignores a future `history_created_at_ms > now_ms`), becoming eligible once 3 engaged sessions spaced >= 5 min apart occur.
- Rust `star_prompt`: interactions within the 5-minute cooldown do not double-count; backward wall-clock jumps (`now_ms < last_interaction_at_ms`) do not corrupt session counts; once `engagement_sessions` reaches 3, further `record_interaction` calls do not rewrite the file on disk.
- Rust `star_prompt`: `StarPromptAction::Starred` persists permanent opt-out (`eligible: false`, survives reload) and stops future interaction disk writes.
- Rust `star_prompt`: `StarPromptAction::Dismissed` persists permanent opt-out (`eligible: false`, survives reload).
- Rust `star_prompt`: `StarPromptAction::Snoozed` hides the prompt for 7 days (`eligible: false` at 7d, `eligible: true, can_snooze: false` at 7d+1ms); calling `Snoozed` a second time permanently dismisses so it never re-appears.
- Rust `star_prompt`: corrupted JSON or binary non-UTF-8 bytes on disk fall back gracefully without panicking; `FileStarPromptStore` writes atomically with owner-only `0o600` permissions on Unix; save failure returns `Err(CommandError::SettingsNotSaved)` without mutating in-memory state.
- Store `inventory.rs`: `Reader::created_at_ms` returns `Some(ms)` on a new store and `None` when `created_at_ms` is absent or non-numeric.
- Core `star-prompt.test.ts`: `shouldShowStarPrompt` returns true only when every guard passes (`eligible`, `onboardingCompleted`, `!hasFocalNotice`, `historyAvailable`, `windowVisible`, `delayElapsed`), and false if any guard fails or `status` is null/undefined.
- Core `star-prompt.test.ts`: `formatSystemDiagnostics` normalizes CRLF/LF and blank whitespace, strips leading `v`/`V`, avoids duplicating `macOS`/`Linux` prefixes (case-insensitive), falls back to `model` when `chip` is absent, and never includes hostnames/IPs.
- UI `star-prompt-card.test.tsx`: renders exact honest copy, `role="status"`, primary `"Star on GitHub"` button, `"Not now"` when `canSnooze=true`, `"Don't ask again"` when `canSnooze=false`, and `×` dismiss button; wires callbacks for Star, Snooze, Dismiss, and Escape key.
- UI `star-prompt-host.test.tsx`: waits `delayMs` (default 8000ms) before showing, clears/restarts the timer when window hides then shows, suppresses when onboarding incomplete, focal notice active, history unavailable (`useHistoryHealth().error !== null`), or window hidden; renders `"Don't ask again"` when `can_snooze: false`; supports Escape dismissal; clicking Star opens `GITHUB_REPO_URL`, calls `actOnStarPrompt("starred")`, and hides; clicking Not now calls `actOnStarPrompt("snoozed")` and hides; clicking Dismiss calls `actOnStarPrompt("dismissed")` and hides; verifies mock transport stateful transitions; handles `openUrl` / `actOnStarPrompt` errors cleanly; Dashboard route mounts it without re-rendering `DashboardLayout`, and neither `/popover` nor `/onboarding` mounts it.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src-tauri/src/star_prompt.rs | src-tauri/src/settings.rs, src-tauri/src/error.rs | src-tauri/src/star_prompt.rs | opus | pending | | `cargo test -p statglass star_prompt` and `cargo check --workspace --all-targets` pass |
| b | S | src/core/star-prompt.ts | src/core/transport/contracts.ts | src/core/star-prompt.test.ts | sonnet | pending | | `bun run test -- src/core/star-prompt.test.ts` and `bun run typecheck` pass |
| c | M | src/app/components/star-prompt-card.tsx, src/app/routes/dashboard/_components/star-prompt-host.tsx, src/app/routes/dashboard/route.tsx | src/core/star-prompt.ts, src/app/hooks/use-history-health.ts, src/app/components/ui/button.tsx, src/app/lib/motion/enter.ts | src/app/components/star-prompt-card.test.tsx, src/app/routes/dashboard/_components/star-prompt-host.test.tsx, src/app/routes/dashboard/route.test.tsx | opus | pending | | card, host, and dashboard route tests + `bun run typecheck` + `bun run lint` pass |

#### Lane a brief

- Goal: Implement the Rust star-prompt state machine, atomic owner-only JSON persistence, engagement session tracking, and Tauri commands in `src-tauri/src/star_prompt.rs`.
- Interface: Implement all public items stubbed in `src-tauri/src/star_prompt.rs`: constants `GITHUB_REPO_URL`, `GITHUB_ISSUES_URL`, `MIN_ELAPSED_MS`, `SNOOZE_DURATION_MS`, `ENGAGEMENT_COOLDOWN_MS`, `REQUIRED_ENGAGEMENT_SESSIONS`; types `StarPromptStatus`, `StarPromptAction`; `StarPromptStore` trait (for testable pure I/O boundary) and `FileStarPromptStore` (atomic temp-file + rename + `statglass_store::restrict`), `StarPromptOwner` (`open`, `with_store`, `status`, `record_interaction`, `act`), and commands `get_star_prompt_status`, `act_on_star_prompt`. Keep all scaffold `#[cfg(test)]` tests intact and passing; you may add tests only inside `src-tauri/src/star_prompt.rs` without weakening any existing test.
- Behavior:
  - State persisted in `star-prompt.json` (versioned or serde-defaulted struct): `first_seen_at_ms: i64`, `engagement_sessions: u32`, `last_interaction_at_ms: Option<i64>`, `snooze_count: u32`, `snoozed_until_ms: Option<i64>`, `dismissed_at_ms: Option<i64>`, `starred_at_ms: Option<i64>`.
  - `open(dir, history_created_at_ms, now_ms)`: loads `dir.join("star-prompt.json")`. If missing, creates fresh state with `first_seen_at_ms = history_created_at_ms.map_or(now_ms, |c| c.min(now_ms))` and persists best-effort. If invalid JSON or read error (other than NotFound), logs `tracing::warn!` and falls back to fresh state (seeded same way) without panicking.
  - `status(now_ms)`: `eligible` is `true` iff `starred_at_ms.is_none() && dismissed_at_ms.is_none() && now_ms.saturating_sub(first_seen_at_ms) > MIN_ELAPSED_MS && engagement_sessions >= REQUIRED_ENGAGEMENT_SESSIONS && snoozed_until_ms.is_none_or(|until| now_ms > until)`. `can_snooze` is `snooze_count == 0`.
  - `record_interaction(now_ms)`: if `starred_at_ms.is_some() || dismissed_at_ms.is_some() || engagement_sessions >= REQUIRED_ENGAGEMENT_SESSIONS`, return immediately without writing to disk. If `last_interaction_at_ms` is `Some(last)` and `now_ms.saturating_sub(last) < ENGAGEMENT_COOLDOWN_MS` (and `now_ms >= last`), return immediately without writing. Otherwise increment `engagement_sessions`, set `last_interaction_at_ms = Some(now_ms)`, and persist (logging `tracing::warn!` on failure).
  - `act(action, now_ms)`: clones current state, applies transition on the clone, saves via store FIRST (returning `Err(CommandError::SettingsNotSaved { message })` without mutating in-memory state if save fails), then commits to memory and returns updated `status(now_ms)`:
    - `Starred`: sets `starred_at_ms = Some(now_ms)`, clears `snoozed_until_ms`.
    - `Dismissed`: sets `dismissed_at_ms = Some(now_ms)`, clears `snoozed_until_ms`.
    - `Snoozed`: if `snooze_count == 0`, sets `snooze_count = 1` and `snoozed_until_ms = Some(now_ms.saturating_add(SNOOZE_DURATION_MS))`; if `snooze_count >= 1`, sets `dismissed_at_ms = Some(now_ms)` and clears `snoozed_until_ms` so a second snooze permanently opts out.
  - Use poison-safe locks (`statglass_schema::lock::LockExt`), no `.unwrap()` in production code, keep functions <= 40 lines and file <= 450 nonblank production lines.
- Decisions already made: Separate `star-prompt.json` file (not inside `settings.json`); strictly `> 24h`; 3 sessions with 5-minute cooldown; 7-day single snooze; seed existing users from `history_created_at_ms`.
- Out of scope: Do not touch `lib.rs`, `state.rs`, `windows.rs`, `app_menu.rs`, or `bindings.ts`.
- Done when: `cargo test -p statglass star_prompt`, `cargo clippy -p statglass --all-targets -- -D warnings`, and `plan_graph.py check-lane` pass.

#### Lane b brief

- Goal: Implement the pure TypeScript star-prompt constants, calm-moment eligibility guard, and non-PII system diagnostics formatter in `src/core/star-prompt.ts`.
- Interface: Implement every export stubbed in `src/core/star-prompt.ts`: `GITHUB_REPO_URL`, `GITHUB_ISSUES_URL`, `STAR_PROMPT_DELAY_MS`, `StarPromptGuardInput`, `shouldShowStarPrompt`, `SystemDiagnosticsInput`, `formatSystemDiagnostics`.
- Behavior:
  - `GITHUB_REPO_URL = "https://github.com/steamfield/statglass"`
  - `GITHUB_ISSUES_URL = "https://github.com/steamfield/statglass/issues"`
  - `STAR_PROMPT_DELAY_MS = 8_000`
  - `shouldShowStarPrompt(input)`: returns `true` iff `Boolean(input.status?.eligible) && input.onboardingCompleted && !input.hasFocalNotice && input.historyAvailable && input.windowVisible && input.delayElapsed`.
  - `formatSystemDiagnostics({ appVersion, osVersion, chip, model })`: trims non-empty parts; starts with `StatGlass v${appVersion.trim()}` (stripping any leading `v` on `appVersion` so `v0.12.1` never becomes `vv0.12.1`), appends `osVersion` (prefixed with `macOS ` only if it doesn't already start with `macOS` or `Linux`, case-insensitive), appends `chip` if present, else `model` if present; joins non-empty parts with `" · "`. Pure function, no React imports.
- Decisions already made: `src/core/` has zero React imports; diagnostics exclude hostnames, serials, usernames, and IPs.
- Out of scope: No transport calls, no React hooks, no URL query-string builders.
- Done when: `bun run test -- src/core/star-prompt.test.ts`, `bun run typecheck`, `bun run lint`, and `plan_graph.py check-lane` pass.

#### Lane c brief

- Goal: Build `StarPromptCard`, `StarPromptHost`, and wire `<StarPromptHost />` into `DashboardLayout` so engaged >24h users see a calm, non-intrusive bottom-right hover-card toast in the dashboard window only.
- Interface:
  - `src/app/components/star-prompt-card.tsx`: `StarPromptCard({ canSnooze, onStar, onSnooze, onDismiss, className? })`
  - `src/app/routes/dashboard/_components/star-prompt-host.tsx`: `StarPromptHost({ hasFocalNotice, delayMs? })`
  - `src/app/routes/dashboard/route.tsx`: mount `<StarPromptHost hasFocalNotice={useFocal} />` inside `DashboardLayout`'s outer container (never inside `<main>`'s `pageEnter` div so it stays fixed bottom-right and never causes `DashboardLayout` to re-render when prompt state changes).
- Behavior:
  - `StarPromptCard`:
    - Semantic container `<aside role="status" aria-label="Star StatGlass on GitHub">` (non-modal, never steals focus) with StatGlass surface styling: `rounded-card border border-border bg-popover p-4 text-popover-foreground shadow-md dark:shadow-none`, using ONLY StatGlass theme tokens (no `text-[Npx]`, no `rounded-md`/`rounded-lg`, no `strokeWidth` prop on lucide icons — use `icon-regular`, no uppercase, no glow halos, no emoji, no Sparkles icon).
    - Subtle entrance animation via `enter(0, "lift")` from `~/lib/motion/enter` (respects Reduce Motion and Performance mode automatically; no `opacity: 0` in base rules).
    - Header row: lucide `<Star aria-hidden className="icon-regular size-4 shrink-0 text-power" />`, title `"Enjoying StatGlass?"` (`font-semibold text-body text-foreground`), and close button (`Button` variant="ghost" size="icon", `aria-label="Dismiss"`, lucide `<X aria-hidden className="icon-regular size-3.5" />`) calling `onDismiss`.
    - Body copy: `"StatGlass is free and open source. A star on GitHub helps others discover it."` (`mt-1.5 font-normal text-small text-muted-foreground`).
    - Actions row (`mt-3 flex items-center gap-2`): primary `<Button size="sm" onClick={onStar}>Star on GitHub</Button>` and secondary `<Button variant="ghost" size="sm" onClick={canSnooze ? onSnooze : onDismiss}>{canSnooze ? "Not now" : "Don't ask again"}</Button>`.
    - Pressing `Escape` while focus is inside the card calls `onDismiss`.
  - `StarPromptHost`:
    - Fetches `transport.getStarPromptStatus()` once on mount (guarded against unmounted state updates).
    - Reads onboarding completion from `useSettings((s) => s.onboarding.completed)` (defaults to `false` until settings load so it never flashes prematurely).
    - Reads history availability via the existing `useHistoryHealth()` hook (`src/app/hooks/use-history-health.ts`), treating `historyAvailable = health !== undefined && error === null` (so the prompt waits until health resolves and stays suppressed whenever `history_health` returns `history_unavailable` or any command error).
    - Tracks native window visibility (`transport.windowVisible()` + `transport.onWindowVisibility`), defaulting to `true` until updated.
    - Starts a `setTimeout` for `delayMs ?? STAR_PROMPT_DELAY_MS` once the window is visible and `status?.eligible` is true (clears timer on unmount or when window hides).
    - Renders `shouldShowStarPrompt(...)` -> `<div className="fixed right-5 bottom-5 z-30 w-[320px] max-w-[calc(100vw-2rem)]"><StarPromptCard ... /></div>`.
    - `onStar`: hides card immediately, calls `transport.openUrl(GITHUB_REPO_URL)` (catching and logging + `toast("Couldn't open link.")` on rejection) and `transport.actOnStarPrompt("starred")` (logging if `status === "error"` or rejected).
    - `onSnooze`: hides card immediately, calls `transport.actOnStarPrompt("snoozed")` (logging errors).
    - `onDismiss`: hides card immediately, calls `transport.actOnStarPrompt("dismissed")` (logging errors).
  - `DashboardLayout`: keep `route.test.tsx`'s render-stability test green (`StarPromptHost` is a memoized child component that owns its own hooks so `DashboardLayout` render count does not increase!).
- Decisions already made: Bottom-right floating card in DashboardLayout only; never rendered in Popover or Onboarding; exact phrasing above.
- Out of scope: Do not touch `sidebar.tsx`, `general-panel.tsx`, `app-components.tsx`, or any test files.
- Done when: `bun run test -- src/app/components/star-prompt-card.test.tsx src/app/routes/dashboard/_components/star-prompt-host.test.tsx src/app/routes/dashboard/route.test.tsx`, `bun run typecheck`, `bun run lint`, and `plan_graph.py check-lane` pass.

### Phase 2: Feedback surfaces, Settings diagnostics, Dev Gallery and E2E

Demo: `bun run dev:fast` to verify the left sidebar "Feedback" button + HoverCard, Settings General panel's "Feedback & issues" (with "Copy system info" and "File feedback") and "Support StatGlass" ("Star on GitHub"), the Dev Gallery specimen (`/?route=/dev/gallery`), and Playwright E2E; run `bun run dev` on macOS to verify the tray right-click "Send Feedback…" and native macOS Help menu when "Show in Dock" is enabled.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src-tauri/src/app_menu.rs, src-tauri/src/tray/mod.rs | src-tauri/src/star_prompt.rs, src-tauri/src/lib.rs | src-tauri/src/app_menu.rs | opus | pending | | `cargo test -p statglass app_menu` and `make rust-check` pass |
| b | S | src/app/components/sidebar.tsx, src/app/routes/dashboard/_components/live-sidebar.tsx | src/core/star-prompt.ts, src/app/components/ui/hover-card.tsx | src/app/components/sidebar.test.tsx, src/app/routes/dashboard/route.test.tsx | opus | pending | | sidebar and dashboard route tests + `bun run typecheck` + `bun run lint` pass |
| c | M | src/app/routes/dashboard/settings/_components/general-panel.tsx, src/app/routes/dev/gallery/_sections/app-components.tsx, tests/e2e/star-prompt-and-feedback.spec.ts | src/core/star-prompt.ts, src/app/components/star-prompt-card.tsx, src/app/components/sensor-dump-dialog.tsx, src/app/routes/dashboard/settings/_components/update-row.tsx | src/app/routes/dashboard/settings/route.test.tsx | opus | pending | | settings tests, gallery tests, Playwright E2E, `bun run typecheck`, and `bun run lint` pass |

(Phase 2 test cases and full lane briefs written during Phase 1.)

## Log

- 2026-11-21: Sprint started on `sprint/github-star-and-feedback` (base `main`). Grill settled in 1 round. All lanes, critique, and final review routed to Gemini 4 Neon (`antigravity` / `gemini-4-neon`).
- 2026-11-21: Plan critique triage (5 findings from Gemini 4 Neon devils-advocate):
  - Finding 1 (HistoryHealth API): Applied — `StarPromptHost` now uses `useHistoryHealth()` with `health !== undefined && error === null`, added to Lane c `Reads`.
  - Finding 2 (file/path/text edge cases): Applied — added tests for `0o600` permissions, binary/non-UTF-8 `star-prompt.json`, missing/non-numeric `created_at_ms`, CRLF/LF whitespace and `V`/prefix handling in `formatSystemDiagnostics`.
  - Finding 3 (missing Phase 1 test coverage): Applied — added tests for `/onboarding` exclusion, `can_snooze: false` + Escape in `StarPromptHost`, window hide/show timer reset, backward clock jump in `record_interaction`, and mock stateful transitions.
  - Finding 4 (missing Contracts/Layout items): Applied — added `StarPromptStore`, `FileStarPromptStore`, `StarPromptOwner::with_store`, `AppState::star_prompt`, and `src-tauri/capabilities/default.json` to Contracts & Layout.
  - Finding 5 (Model column vs Gemini 4 Neon): Noted — `plan_graph.py` expects `opus`/`sonnet` tier labels for lane-review policy; all delegated invocations dispatch to `antigravity` / `gemini-4-neon` (`high` for `opus` rows, `medium` for `sonnet`/critique).
