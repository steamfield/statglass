# Delegating work in this repository

What a foreman or Codex contract for StatGlass must carry, so a delegated run follows the
same conventions as a session here. A contract is built from one lane brief; it repeats the
items below because the delegated agent may not read `CLAUDE.md` or `.claude/rules/` on its
own. Point it at `AGENTS.md`, which indexes the rules by path.

## Setup

- The run works in its own Git worktree on its own branch, cut from the scaffold commit the plan names.
- First command in the worktree: `bun install --frozen-lockfile`; hooks, lint and tests fail without it, and the lockfile must not change.
- One plain command per shell call, with repo-relative paths; no `cd <dir> && ...`, loops or variable assignments around git, which worktree guards refuse.

## Scope

- The lane edits only the files and directories its brief owns; a change it needs elsewhere is reported, not made.
- Tests named in the brief as the definition of done are read-only in an implementation lane.
- Generated files are regenerated, never edited: `packages/core/src/generated/` and `src/desktop-transport/commands.ts` (`make bindings`), the XCFramework and Swift bindings (`scripts/mobile/build-rust-ios.sh`), `AGENTS.md` and `.agents/` (`make agent-config`), and `apps/mobile/ios/` (`expo prebuild`, uncommitted).
- Rust types are the source of truth for every TypeScript type that mirrors them; no hand-written copies.

## Commands to give the run

Filtered tests, one per area the lane touches:

```bash
bun run test -- <path>                     # desktop (src/, tests/) and packages/core (Vitest)
bun run --cwd apps/mobile test -- <path>   # mobile (jest-expo on Node, never bun test)
cargo test -p <crate> <filter>             # Rust
bun run typecheck                          # desktop, test and Node tooling TypeScript projects
```

Area checks: `make mobile-check` (mobile), `make mobile-rust-check` (Rust that `statglass-mobile`
links), `make rust-check`, `make architecture-check architecture-test` (crate edges, Biome
boundaries), `make bindings-check` (any Rust type or command change).

The gate the lane must pass before it reports done is the one in the plan header. For the
iPhone plan it is:

```bash
make agent-config-check agent-config-test agent-hooks-test verification-test architecture-check architecture-test rust-check appstore-check rust-test bindings-check mobile-check mobile-rust-check && bun run check
```

`make updater-patch-test` fails in any worktree nested under the main checkout; it runs once
from main after landing, not in a lane.

## Commits

- One commit per lane on the lane's branch, staging owned files by path (never `git add -A` or `git add .`, which picks up a symlinked `node_modules`).
- Conventional commit subjects, `type(scope): subject` (for example `feat(mobile): ...`, `refactor(core): ...`, `docs(agents): ...`); the commit hook rejects others.
- Do not bypass hooks with `--no-verify`.
- No pushes, merges, rebases onto other branches or worktree removal; landing belongs to the orchestrator.

## Hosted runner policy (D-118, D-131)

The only GitHub-hosted macOS job is the tag-triggered desktop release job. A run never adds a
macOS runner to any workflow, never dispatches or reruns a workflow that has one, and never
uses a larger runner size. iOS builds, simulator checks and native module tests run locally.
Changing this needs a new decision from the owner, not a lane.

## Report

The contract asks for a short report: what changed, the exact checks run and their results
(test counts, not just exit codes), anything left undone, and every choice the brief did not
settle. Screens changed on either platform come with screenshots and a named list of
differences from the design system and the neighboring screens.
