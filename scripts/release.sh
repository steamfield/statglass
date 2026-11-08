#!/usr/bin/env bash
# Cut and publish a StatGlass release. See .github/releasing.md for the whole flow.
#
#   scripts/release.sh cut 0.9.0      bump versions, commit, push main, tag, push the tag
#   scripts/release.sh publish 0.9.0  check the draft's DMG, then publish the draft
#
# Write RELEASE_NOTES.md ("# StatGlass 0.9.0") and the CHANGELOG.md entry
# ("## [0.9.0](...)") before `cut`; they go into the release commit. The tag starts the
# Release workflow, which waits for your approval in the `release` environment and then
# builds, signs, notarizes and uploads a draft release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REPO=steamfield/statglass

die() { echo "release: $*" >&2; exit 1; }
confirm() { read -r -p "$1 [y/N] " answer; [[ "$answer" == [yY] ]] || die "stopped."; }

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

version_arg() {
  [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "give a version like 0.9.0 (got '${1:-}')."
  echo "$1"
}

cut() {
  local version tag latest
  version="$(version_arg "${1:-}")"
  tag="v$version"

  [[ "$(git branch --show-current)" == main ]] || die "switch to main first."
  local dirty
  dirty="$(git status --porcelain | grep -v -E '^.. (RELEASE_NOTES|CHANGELOG)\.md$' || true)"
  [[ -z "$dirty" ]] || die "commit or stash these first:"$'\n'"$dirty"
  git fetch --quiet --tags origin main
  git merge-base --is-ancestor origin/main HEAD || die "main is behind origin/main; pull first."
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists."
  latest="$(git tag --list 'v*' --sort=-v:refname | head -1)"
  [[ "$(printf '%s\n%s\n' "${latest#v}" "$version" | sort -V | tail -1)" == "$version" && "${latest#v}" != "$version" ]] ||
    die "$version is not newer than $latest."

  head -1 RELEASE_NOTES.md | grep -qx "# StatGlass $version" ||
    die "RELEASE_NOTES.md must start with '# StatGlass $version'."
  grep -q "^## \[$version\]" CHANGELOG.md || die "CHANGELOG.md has no '## [$version]' entry."

  echo "release: bumping to $version"
  # The first `version =` in Cargo.toml is [workspace.package]; the first "version" in
  # each JSON file is the app's own.
  perl -0pi -e "s/^version = \"[^\"]+\"/version = \"$version\"/m" Cargo.toml
  for file in package.json src-tauri/tauri.conf.json; do
    perl -0pi -e "s/\"version\": \"[^\"]+\"/\"version\": \"$version\"/" "$file"
  done
  cargo update --workspace --offline --quiet
  python3 scripts/release-manifest.py "$tag"
  python3 scripts/test-release-manifest.py

  git add Cargo.toml Cargo.lock package.json src-tauri/tauri.conf.json RELEASE_NOTES.md CHANGELOG.md
  git commit -m "chore(release): $version"
  git --no-pager log --oneline origin/main..HEAD
  confirm "Push main (runs the pre-push gate), then tag and push $tag?"
  git push origin main
  git tag -a "$tag" -m "StatGlass $version"
  git push origin "$tag"

  echo "release: $tag pushed. Waiting for the Release workflow to start..."
  local run=""
  for _ in $(seq 1 12); do
    run="$(gh run list --repo "$REPO" --workflow release.yml --branch "$tag" --limit 1 --json url --jq '.[0].url // empty')"
    [[ -n "$run" ]] && break
    sleep 5
  done
  echo "release: approve the macos job in the 'release' environment: ${run:-https://github.com/$REPO/actions/workflows/release.yml}"
  echo "release: when the draft is up, run: scripts/release.sh publish $version"
}

publish() {
  local version tag dir mount
  version="$(version_arg "${1:-}")"
  tag="v$version"

  [[ "$(gh release view "$tag" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null)" == true ]] ||
    die "$tag has no draft release (still building, or already published)."
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' EXIT
  gh release download "$tag" --repo "$REPO" --pattern StatGlass_aarch64.dmg --pattern SHA256SUMS --dir "$dir"
  (cd "$dir" && grep ' StatGlass_aarch64.dmg$' SHA256SUMS | shasum -a 256 -c -)

  # A downloaded file carries quarantine, so this is the check Gatekeeper makes on a user's Mac.
  xcrun stapler validate "$dir/StatGlass_aarch64.dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dir/StatGlass_aarch64.dmg"
  mount="$dir/mount"
  mkdir "$mount"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dir/StatGlass_aarch64.dmg" >/dev/null
  spctl --assess --type execute --verbose=2 "$mount/StatGlass.app" || { hdiutil detach "$mount" >/dev/null; die "Gatekeeper rejects the app."; }
  hdiutil detach "$mount" >/dev/null
  echo "release: the draft DMG is notarized and passes Gatekeeper."

  cp "$dir/StatGlass_aarch64.dmg" "$HOME/Downloads/StatGlass-$version.dmg"
  echo "release: copied it to ~/Downloads/StatGlass-$version.dmg."
  echo "         Open it on a fresh macOS account or another Mac, and check an update from the previous release."
  confirm "Publish $tag as the latest release? Installed apps will start updating to it."
  gh release edit "$tag" --repo "$REPO" --draft=false --latest
  echo "release: $tag is published: https://github.com/$REPO/releases/tag/$tag"
}

case "${1:-}" in
  cut) shift; cut "$@" ;;
  publish) shift; publish "$@" ;;
  -h|--help|help) usage ;;
  *) usage 1 ;;
esac
