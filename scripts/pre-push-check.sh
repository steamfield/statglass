#!/usr/bin/env bash
# Preserve live evidence even while pre-commit buffers the hook's output.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
mkdir -p target/qa/pre-push
evidence="$(mktemp -d "$PWD/target/qa/pre-push/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
printf 'Pre-push evidence: %s\n' "$evidence"
trap 'printf "%s\n" "$?" > "$evidence/result.txt"' EXIT
git rev-parse HEAD > "$evidence/revision.txt"
git status --porcelain=v1 > "$evidence/working-tree.txt"

# The perf budgets measure real hardware and move with machine load, so they run only
# when the push changes code that can move them. A change to this script, the Makefile
# or the budgets runs both.
always_perf='^(scripts/pre-push-check\.sh|Makefile|perf-budget\.json)$'
# The engine budgets (crates/statglass-engine/tests/perf_gates.rs) and the workspace
# crates the engine builds on.
rust_perf_paths='^(crates/statglass-(engine|collect|store|schema|proto)/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.cargo/)'
# The production frontend build the Playwright perf gate measures.
e2e_perf_paths='^(src/|packages/core/|index\.html$|vite\.config\.ts$|tsconfig[^/]*\.json$|package\.json$|bun\.lock$|playwright\.config\.ts$|tests/e2e/perf-gate\.spec\.ts$)'

# pre-commit exports the pushed range for an ordinary push. A manual run, a push of a
# whole history, or STATGLASS_PERF=1 (set by scripts/release.sh) runs every gate.
changed=""
perf_scope="all"
if [[ "${STATGLASS_PERF:-}" != 1 && -n "${PRE_COMMIT_FROM_REF:-}" && -n "${PRE_COMMIT_TO_REF:-}" ]]; then
    changed="$(git diff --name-only --no-ext-diff "$PRE_COMMIT_FROM_REF...$PRE_COMMIT_TO_REF")"
    perf_scope="paths"
fi
printf '%s\n' "$perf_scope" > "$evidence/perf-scope.txt"
printf '%s\n' "$changed" > "$evidence/changed-files.txt"

wanted() {
    local paths
    [[ "$perf_scope" == all ]] && return 0
    case "$1" in
        rust-perf) paths=$rust_perf_paths ;;
        e2e-perf) paths=$e2e_perf_paths ;;
        *) return 0 ;;
    esac
    grep -qE -e "$always_perf" -e "$paths" <<<"$changed"
}

for stage in check bindings-check rust-perf e2e-perf; do
    if ! wanted "$stage"; then
        printf '\nSkipping %s: the push changes nothing it measures (STATGLASS_PERF=1 runs it)\n' "$stage"
        printf '%s\tskipped\n' "$stage" >> "$evidence/stages.tsv"
        continue
    fi
    printf '%s\n' "$stage" > "$evidence/current-stage.txt"
    printf '\nStarting %s\n' "$stage"
    if make "$stage" 2>&1 | tee "$evidence/$stage.log"; then
        printf '%s\t0\n' "$stage" >> "$evidence/stages.tsv"
    else
        status=$?
        printf '%s\t%s\n' "$stage" "$status" >> "$evidence/stages.tsv"
        printf 'Failed %s; evidence: %s\n' "$stage" "$evidence" >&2
        exit "$status"
    fi
done
printf 'All pre-push gates passed; evidence: %s\n' "$evidence"
