#!/bin/bash
# Stop / SubagentStop hook: kill orphaned dev-tool processes left behind by
# this hook's checkout. Sibling worktrees are reported, never signalled.
#
# When an agent's Bash call is cut off (timeout, interrupt, a killed parent),
# tsc / vitest workers / eslint / mypy can be reparented to PID 1 and keep a
# core busy for minutes. With several agents in parallel worktrees that adds up
# to a saturated laptop. This sweeps them up when a turn ends.
#
# Deliberately narrow. A tool process is reaped only if ALL of these hold:
#   - the program is tsc, vitest (incl. its fork/tinypool workers), eslint,
#     mypy (not dmypy), playwright, or `vite build` -- as argv[0], or as the
#     script an interpreter (node/bun/python) is running. A tool name appearing
#     later in argv (`rr run 'bunx vitest ...'`) does not count,
#   - it is orphaned: either its own parent is PID 1, or every process between
#     it and PID 1 is a launcher (bun, bunx, uv, uvx, npx, `sh -c`, `bash -c`,
#     or node running a checkout script) -- what `bun run typecheck` and
#     `uv run mypy` leave behind. Then that topmost launcher's whole tree goes,
#   - the topmost process has run longer than REAP_ORPHANS_MIN_AGE seconds (120),
#   - the tool's or a launcher's command line names a path inside this
#     checkout (other worktrees are only reported),
#   - it is ours (ps -U <uid>) and not an ancestor of this hook.
#
# cargo, rustc and pytest are not in the tool list, so they never match.
# nohup execs its command, so a nohup'd tool run looks like any other orphan:
# to keep one alive on purpose, give it a non-launcher parent.
# Bare `vite` / `vite dev` / `vite preview` are servers and are left alone.
#
# Fast (one ps, one git call), never fails the session (always exits 0), and
# logs one line to stderr when it kills something.
#
# Test seams: REAP_ORPHANS_PS_FILE replaces the ps listing (lines of
# "pid ppid etime command..."); REAP_ORPHANS_ROOTS replaces the checkout roots
# (newline-separated); REAP_ORPHANS_SELF stands in for this hook's pid;
# REAP_ORPHANS_DRY_RUN=1 sends no signals to candidates.
# REAP_ORPHANS_TIMING appends durations in ms or status=interrupted to a local file.

git_phase() {
    hook_root=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)
    roots=${REAP_ORPHANS_ROOTS-$(git -C "$hook_root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')}
    roots="$hook_root"$'\n'"$roots"
    roots=$(printf '%s' "$roots" | tr '\n' '|')
}

ps_phase() {
    if [[ -n "${REAP_ORPHANS_PS_FILE:-}" ]]; then
        listing=$(cat "$REAP_ORPHANS_PS_FILE" 2>/dev/null)
    else
        listing=$(exec ps -ww -U "$(id -u)" -o pid=,ppid=,etime=,command= 2>/dev/null)
    fi
}

# Output: "<ownership> <top pid> <tool> <pid> <pid>..." per candidate tree.
# A mixed-checkout tree is also left alone rather than killing a sibling child.
awk_phase() {
    victims=$(printf '%s\n' "$listing" | awk -v min_age="${REAP_ORPHANS_MIN_AGE:-120}" -v roots="$roots" -v own="$hook_root" -v self="${REAP_ORPHANS_SELF:-$$}" '
    function secs(t,   d, n, p, s, i) {          # etime: [[dd-]hh:]mm:ss
        d = 0
        if (index(t, "-")) { d = substr(t, 1, index(t, "-") - 1); t = substr(t, index(t, "-") + 1) }
        n = split(t, p, ":"); s = 0
        for (i = 1; i <= n; i++) s = s * 60 + p[i]
        return d * 86400 + s
    }
    function base(p) { sub(/.*\//, "", p); return p }
    function checkout_at(path,   i, match_root) {
        # Resolve nesting for this path occurrence, not for the whole command.
        match_root = ""
        for (i = 1; i <= nr; i++)
            if (r[i] != "" && substr(path, 1, length(r[i]) + 1) == r[i] "/" && length(r[i]) > length(match_root)) match_root = r[i]
        return match_root
    }
    function names_checkout(p,   i) {
        for (i = 1; i <= nr; i++)
            if (r[i] != "" && index(cm[p], r[i] "/")) return 1
        return 0
    }
    function names_sibling(p,   rest, slash, root) {
        rest = cm[p]
        while ((slash = index(rest, "/")) != 0) {
            rest = substr(rest, slash)
            root = checkout_at(rest)
            if (root != "" && root != own) return 1
            # An enclosing root at this same occurrence is only a prefix. Continue
            # after the selected root so a separate sibling argument still counts.
            rest = substr(rest, root == "" ? 2 : length(root) + 1)
        }
        return 0
    }
    function has_sibling(p,   k) {
        if (names_sibling(p)) return 1
        for (k = 1; k <= n; k++)
            if (pp[order[k]] == p && has_sibling(order[k])) return 1
        return 0
    }
    function tool_of(p,   b0, b1) {
        b0 = base(a0[p]); b1 = base(a1[p])
        if (b0 ~ /^(tsc|vitest|eslint|mypy|playwright)$/) return b0
        if (b0 == "vite") return (a1[p] == "build") ? "vite" : ""
        if (b0 ~ /^(node|bun|python[0-9.]*)$/) {
            if (b1 ~ /^(tsc|vitest|eslint|mypy|playwright)$/) return b1
            if (b1 == "vite") return (a2[p] == "build") ? "vite" : ""
            if (a1[p] ~ /\/node_modules\/(vitest|tinypool)\//) return "vitest"
            if (a1[p] ~ /\/node_modules\/(@playwright\/test|playwright)\//) return "playwright"
            if (a1[p] == "-m" && a2[p] == "mypy") return "mypy"
        }
        return ""
    }
    function launcher(p,   b0) {
        b0 = base(a0[p])
        if (b0 ~ /^(bun|bunx|uv|uvx|npx)$/) return 1
        if (b0 ~ /^(sh|bash)$/) return a1[p] == "-c"
        if (b0 == "node") return names_checkout(p)
        return 0
    }
    function subtree(p,   out, k) {
        out = " " p
        for (k = 1; k <= n; k++) if (pp[order[k]] == p) out = out subtree(order[k])
        return out
    }
    BEGIN { nr = split(roots, r, "|") }
    NF >= 4 {
        p = $1; pp[p] = $2; et[p] = secs($3); a0[p] = $4; a1[p] = $5; a2[p] = $6
        c = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, "", c); cm[p] = c
        order[++n] = p
    }
    END {
        for (q = self; q in pp; q = pp[q]) mine[q] = 1     # never our own ancestry
        for (k = 1; k <= n; k++) {
            p = order[k]; t = tool_of(p)
            if (t == "") continue
            top = p; named = names_checkout(p); ok = 1; depth = 0
            while (pp[top] != 1) {
                up = pp[top]
                if (!(up in pp) || ++depth > 4 || !launcher(up)) { ok = 0; break }
                top = up
                if (names_checkout(top)) named = 1
            }
            if (!ok || !named || et[top] <= min_age || (top in mine) || (top in done)) continue
            done[top] = 1
            print (has_sibling(top) ? "sibling" : "own"), top, t subtree(top)
        }
    }')
}

kill_phase() {
    [[ -z "$victims" ]] && return 0

    local killed="" ownership top tool pids action
    while read -r ownership top tool pids; do
        if [[ "$ownership" == sibling ]]; then
            echo "reap-orphans: left sibling-worktree orphan alone: $top $tool" >&2
            continue
        fi
        # shellcheck disable=SC2086  # $pids is a list
        [[ -z "${REAP_ORPHANS_DRY_RUN:-}" ]] && kill -TERM $pids 2>/dev/null
        killed+="${killed:+, }$top $tool"
    done <<< "$victims"

    if [[ -n "$killed" ]]; then
        action="killed"
        [[ -n "${REAP_ORPHANS_DRY_RUN:-}" ]] && action="would reap"
        echo "reap-orphans: $action orphaned dev processes: $killed" >&2
    fi
}

run_hook() {
    set +m  # Keep the phase commands in the worker's group.
    trap 'exit 143' TERM  # Let Bash reap its foreground child before exiting.
    local TIMEFORMAT='%3R' phases git_ms ps_ms awk_ms kill_ms
    phases=$({
        trap 'exit 143' TERM
        cat >/dev/null 2>&1   # hook payload; nothing in it is needed
        time git_phase 2>&3
        [[ -z "$roots" ]] && exit 0
        time ps_phase 2>&3
        time awk_phase 2>&3
        time kill_phase 2>&3
    } 3>&2 2>&1) || return $?
    [[ -n "$timing" && ! -p "$timing" ]] || return 0  # A FIFO can block an append.
    phases=${phases//[.,]/}
    read -r git_ms ps_ms awk_ms kill_ms <<< "${phases//$'\n'/ }"
    trap '' TERM  # Finish the timing record once the phases have completed.
    printf 'git_ms=%d ps_ms=%d awk_ms=%d kill_ms=%d\n' \
        "$((10#${git_ms:-0}))" "$((10#${ps_ms:-0}))" "$((10#${awk_ms:-0}))" "$((10#${kill_ms:-0}))" 2>/dev/null >> "$timing" || :
}

timing=${REAP_ORPHANS_TIMING:-} cancelled="" interrupted=""
trap 'cancelled=1' HUP INT TERM
exec 3>&2 2>/dev/null  # Hide job-control diagnostics. Keep worker stderr on fd 3.
set -m
run_hook <&0 2>&3 & worker=$!
( set +m; trap 'exit 0' TERM
    sleep 8 && kill -TERM -- "-$worker" && sleep 0.25 && kill -KILL -- "-$worker"
) & timer=$!
set +m
if [[ -n "$cancelled" ]] || ! wait "$worker"; then
    trap '' HUP INT TERM
    kill -TERM -- "-$worker"
    wait "$worker" || { interrupted=1; kill -KILL -- "-$worker"; }
fi
trap '' HUP INT TERM
kill -TERM -- "-$timer"
wait "$timer"
[[ -z "$interrupted" || -z "$timing" || -p "$timing" ]] || printf 'status=interrupted\n' >> "$timing"
exit 0
