#!/usr/bin/env bash
# Runs a formatter from a pre-commit hook, then re-stages the staged files it
# fixed, so a formatting slip lands fixed instead of failing the commit.
#
#   pre-commit-restage.sh [--no-pass] <command...> -- <staged files...>
#
# pre-commit appends the staged files after the trailing `--`. The command gets
# them too unless --no-pass is given (cargo fmt --all takes no paths).
#
# Before hooks run, pre-commit stashes unstaged changes in its store as
# patch<time>-<its pid> and restores them afterwards. Re-staging a fix to a file
# in that patch makes the restore fail and leaves the unstaged edit only in the
# patch, so those files are not re-staged: pre-commit reports them as modified
# and fails the commit, as it did before this wrapper.
set -u

pass=1
if [[ ${1:-} == --no-pass ]]; then
	pass=0
	shift
fi
cmd=()
while (($#)) && [[ $1 != -- ]]; do
	cmd+=("$1")
	shift
done
(($#)) && shift
files=("$@")

if ((pass)); then
	"${cmd[@]}" "${files[@]}"
else
	"${cmd[@]}"
fi
status=$?
((${#files[@]})) || exit "$status"

store=${PRE_COMMIT_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/pre-commit}
partial=""
for patch in "$store"/patch*-"$PPID"; do
	[[ -f $patch ]] || continue
	partial+=$(git apply --numstat -- "$patch" | cut -f3)$'\n'
done

restage=()
for f in "${files[@]}"; do
	grep -qxF -- "$f" <<<"$partial" || restage+=("$f")
done
if ((${#restage[@]})); then
	git add -- "${restage[@]}" || status=1
fi
exit "$status"
