#!/usr/bin/env bash
# Mobile checks that run without Xcode, so Linux CI runs all of them: Biome,
# the theme drift check, the Node script tests, route types and tsc, jest,
# the iOS JS export, Expo's dependency check and the single-React check.
# Run from anywhere; every step runs from the repo root or apps/mobile.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mobile="$repo_root/apps/mobile"
export_dir="$mobile/dist/ios"

cd "$repo_root"

step() {
  printf '\n== mobile-check: %s\n' "$1"
}

step "biome"
bunx biome check apps/mobile scripts/mobile

step "theme tokens match src/app/styles/theme.css"
node apps/mobile/scripts/gen-theme.mjs --check

step "node script tests"
node --test apps/mobile/test/theme-tokens.test.mjs scripts/mobile/fixtures/single-react.test.mjs

step "route types and tsc"
bun run --cwd apps/mobile typecheck

step "jest"
bun run --cwd apps/mobile test --ci

step "expo export (iOS)"
rm -rf "$export_dir"
(cd "$mobile" && bunx expo export --platform ios --output-dir dist/ios --source-maps)

step "expo install --check"
(cd "$mobile" && bunx expo install --check)

step "single React"
node scripts/mobile/single-react.mjs "$export_dir"

printf '\nmobile-check: all steps passed\n'
