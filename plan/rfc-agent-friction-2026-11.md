# RFC: agent friction from the iPhone delivery session (2026-11)

Status: proposed. Source: the `ce:post-mortem` of session c4a7518f (2026-11-24 to
2026-11-25), which ran the iPhone RFC through deliver lanes and foreman, the 0.15.0
release, App Store prep and the README media. The digest counted 52 tool errors,
22 pre-commit failures and 5 Stop-hook timeouts. This RFC fixes the ones with a
systemic cause that is still open.

Already fixed on main, not in scope: the generated-bindings shell guard denying
read-only commands (74eca358), the ios-simulator skill's fallback to simctl when
device access goes unanswered (4f2c55e8), and the quit e2e test owning its clock
(bf6d9404). The ce guidance that new dependencies go in the scaffold is committed in
ce 6.0.5 and not yet pushed.

Not in scope, with reasons: the three attempts to bypass hooks or discard work were
caught by existing guards and rules, so there is nothing to add. Bash calls whose
cwd was a removed worktree are recovered by the harness. Tool-name typos are model
slips.

## Review

A devil's advocate review (2026-11-25) checked this against the code. Accepted and
folded in below: formatting must happen in the PostToolUse hook, not at Stop, since
commits run mid-turn; `git status` needs `--untracked-files=all`, and `-z` rename
entries carry two paths; content hashes replace mtimes for attribution; markers
keyed by `tool_use_id` with failure-event coverage and pruning; the reap hot spot is
the O(L^2) per-character loop in `names_sibling`, and `ps`/`git` costs are measured
before any rewrite; the e2e audit goes per test across all 42 specs, because the quit
test's file already pinned other tests; item 4 was already done (ce 6.0.6). The
review found that `.claude/settings.json` is not generated, so editing it doesn't
affect `make agent-config-check`.

## 1. Shell-written files skip format-on-write

What happened: pre-commit's `cargo fmt` failed 7 times and `frontend biome` 4 times,
all on files Claude wrote with shell commands or python heredocs (scaffold commits,
merge resolutions, renames) and committed in a later Bash call. `lint-on-write.sh`
formats Edit/Write/MultiEdit output immediately; Bash output is never formatted
until pre-commit fails on it.

Fix: format files a Bash call changed, right after the call.

- PreToolUse on Bash stores a marker keyed by `tool_use_id` (documented on
  PreToolUse, PostToolUse and PostToolUseFailure payloads): the checkout root
  resolved from the payload `cwd`, and the dirty set from
  `git status --porcelain -z --untracked-files=all` with each dirty path's content
  hash (`git hash-object`). No `tool_use_id` means do nothing.
- PostToolUse and PostToolUseFailure on Bash read and delete the marker, take the
  dirty set again in the stored root, and select paths that are new to the set or
  whose hash changed. Renames contribute their destination path.
- Selected files are formatted the way `lint-on-write.sh` does it: biome format for
  every extension pre-commit's `frontend-biome` covers
  (`ts|tsx|js|mjs|json|jsonc|css`, any directory), `rustfmt --edition 2024` on the
  selected `.rs` files only (never `cargo fmt --all`), trailing whitespace and EOF.
  Generated paths are skipped. Selected paths are also appended to the session file
  so the Stop pass lint-fixes them.
- PreToolUse prunes markers older than an hour, so a denied or rejected call leaves
  nothing behind.
- Attribution in a shared checkout is best effort: a file someone else edits during
  a long call is formatted too. That only changes formatting, never content.
- Both hook entries use the `[ -x "$h" ] || exit 0` wrapper form and a 10 s timeout.
  The hook exits 0 on every error and must add under 150 ms p95 per call on this repo
  (measured in a test over 20 runs of a no-op command with 30 dirty files).
- A single compound call (`write && git commit`) can't be helped by any hook; the
  commit still fails once. Out of scope.

Owns: `.claude/hooks/format-shell-writes.sh` (new, phase selected by
`hook_event_name`), `.claude/settings.json` (the Bash PreToolUse, PostToolUse and
PostToolUseFailure entries only), `scripts/agent-hooks/test_shell_writes.py` (new).

Tests, through the hook with real git in a temp repo that already has unrelated dirty
files: a new file (in a new directory) is recorded and formatted; a modified tracked
file is; a file dirty before the call and modified again is; a file dirty before and
untouched is not; `git mv` records the destination; a generated path is not
formatted; a read-only command formats nothing; a missing `tool_use_id`, a cwd
outside git and a Post with no marker all exit 0 and do nothing; a stale marker is
pruned; the latency bound above.

Outcome (2026-11-25): not landed. The Codex implementation worked (25 integration
tests, real-Biome QA) but the Pre and Post hooks together added about 260 ms p95 to
every Bash call, and the latency test failed once under load, which would put a
flaky test in pre-push and CI. That cost is out of proportion to one recommit per
failure. The conventional alternative is the lint-staged pattern: the pre-commit
`cargo-fmt` and `frontend-biome` hooks format the staged files and re-stage them,
costing nothing per Bash call and covering human, Claude and Codex commits alike.
It changes commit behavior for everyone (formatting lands silently instead of
failing the commit), so it waits for the maintainer's decision. The lane's patch is
kept outside the repo for reference.

## 2. The reap-orphans Stop hook times out under load

What happened: `reap-orphans.sh` (Stop, 10 s timeout) was cancelled 5 times, all
while a dozen lane worktrees were building. Idle it takes 0.1 s with ~1300 processes.

Likely causes, to be measured, not assumed: `ps -ww` and `git worktree list` under
load, and the per-character loop in `names_sibling` (`reap-orphans.sh:77`), which is
O(L^2) in macOS awk because `length()`/`substr()` are O(L). That loop only runs for
trees that already passed every filter.

Fix:

- Opt-in phase timing (`REAP_ORPHANS_TIMING=<file>` appends one line per run with
  the ms for git, ps, awk and kill) so the next busy run says where time went.
- Replace the per-character walk with a scan over `/` positions found by `index()`
  on the remaining string, keeping behavior identical.
- A watchdog: the hook kills its own awk/ps and exits 0 at 8 s, and the watchdog
  process is reaped on every exit path, so the hook never shows as cancelled and
  never leaves an orphan of its own.

Owns: `.claude/hooks/reap-orphans.sh`, `scripts/agent-hooks/test_reap_orphans_load.py`
(new) and `scripts/agent-hooks/fixtures/reap-*` (new). The existing reap tests in
`test_hooks.py` are read-only.

Tests: a synthetic listing with 1500 processes, 20 roots and several victim trees
whose argv is 8 KB, with the victims the current script selects checked in as a
golden file generated before the rewrite; the rewrite matches it. The timing
assertion runs only on Darwin with a 3 s bound. The watchdog test uses a stub `ps`
that hangs and checks that the hook exits 0 within 10 s and leaves no child process.
The timing file gets one well-formed line per run.

## 3. e2e tests that depend on real-time ticks

What happened: the quit test asserted on a sample that only a later real-time tick
delivered. It failed 6/6 locally and flaked on CI WebKit until it took the clock.
Its file pinned `ticks=0` in its other tests, so a per-file filter would miss it.

Fix: audit every test in the 42 specs in `tests/e2e/`. A test is at risk when it
runs with live ticks (no `ticks=0`, no clock) and asserts on something only a later
tick produces. For each one, take the clock as the quit test does
(`tests/e2e/io-pages.spec.ts:76`), or add a one-line comment saying why it runs in
real time and showing its wait is on a condition. Respect the rule in
`.claude/rules/frontend/testing.md` about keeping live ticks during slow
accessibility scans unless the test controls the stale-data watchdog. Tests driven by
their own fixture (`tick-scroll`) or that assert only on the first render are left
alone. The hand-off lists every test judged at risk and what was done.

Owns: `tests/e2e/` (spec files it changes, new helpers under `tests/e2e/helpers/`).

Tests: each changed test passes `--repeat-each=10` on chromium and webkit; each
converted test is shown to fail once against a temporary break of the behavior it
covers (any file, reverted before hand-off, each break and its red output recorded
in the hand-off).

## 4. Lane Owns lists missed config files (ce)

Done in ce 6.0.6 (`plugins/ce/shared/lane-dag.md:84`), with the dependency rule in
6.0.5. Both are pushed with this work.

## 5. Visual deliverables shown before the full batch (~/.claude)

Done: `~/.claude/CLAUDE.md` now says to send one sample and get a yes before
producing the rest of a batch of media.

## Execution

Items 1 to 3 own disjoint files and run as three parallel Codex lanes through
foreman (`gpt-6.2-sol`), each in its own worktree from main. The orchestrator reviews
each diff, runs `make agent-hooks-test` and the e2e suite, runs `make check` on the
merged result, merges to main and pushes, then smoke-tests item 1 live in a Claude
session and confirms the real payload fields.
