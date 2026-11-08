# Releasing StatGlass

StatGlass stays free. The public channel is an Apple Silicon DMG on GitHub Releases,
signed with a Developer ID and notarized by Apple, so it opens without a Gatekeeper
prompt. A pushed version tag builds, signs, notarizes and uploads a draft release on
GitHub's free macOS runner (D-131); the maintainer checks the draft and publishes it.
Mac App Store and Homebrew distribution are outside this workflow.

## Cutting a release

1. Write `RELEASE_NOTES.md` (first line `# StatGlass X.Y.Z`) and the `CHANGELOG.md`
   entry (`## [X.Y.Z](https://github.com/steamfield/statglass/compare/vPREV...vX.Y.Z) - DATE`).
   Leave them uncommitted.
2. On an up-to-date `main`, run:

   ```sh
   scripts/release.sh cut X.Y.Z
   ```

   It refuses a dirty tree (other than the two notes files), a version that is not
   newer than the latest tag, or notes that do not name the version. It bumps
   `Cargo.toml`, `Cargo.lock`, `package.json` and `src-tauri/tauri.conf.json`, runs the
   manifest checks, and commits `chore(release): X.Y.Z`. After you confirm, it pushes
   `main` through the pre-push gate, then creates and pushes the annotated tag.
3. The tag starts the Release workflow. Linux jobs validate the versions and manifest
   and build both Linux agents. The `macos` job then waits for your approval: open
   the run (the script prints its URL, and GitHub notifies you) and approve the
   `release` environment. It builds the app with the agents bundled, signs the app,
   helper and CLI with the Developer ID under the hardened runtime, notarizes and
   staples the app, builds the signed updater archive and the DMG, then signs,
   notarizes and staples the DMG (`scripts/notarize-dmg.sh`). It checks runtime
   dependencies, stages the assets, signs `statglass-release.json`, writes
   `SHA256SUMS`, runs `verify_release`, and creates a draft release with all of them.
   Expect 20 to 40 minutes; Apple's notarization queue is most of the variance.
4. When the draft exists, run:

   ```sh
   scripts/release.sh publish X.Y.Z
   ```

   It downloads the draft DMG, checks it against `SHA256SUMS`, confirms the stapled
   ticket and that Gatekeeper accepts the DMG and the app inside, and copies the DMG to
   `~/Downloads`. Open that copy on a fresh macOS account or a second Mac and confirm
   it launches with no warning. When a previous release exists, also check a real
   update from it: history and settings survive and the app restarts. Then confirm
   the prompt and the script publishes the draft as the latest release. Only then do
   the fixed `/releases/latest/download/statglass-latest.json` and
   `statglass-release.json` endpoints advertise it to installed apps.

Never replace published assets or reuse a version; fix a bad release with a higher
version. A failed or rejected draft can be deleted and rebuilt by rerunning the
Release workflow for the same tag (Actions, Release, Run workflow, with the tag).
Do not move published tags.

## Signing identities and secrets

Two independent signatures protect a release:

- Apple's: the Developer ID Application certificate for team `YWA9Q642YP`, with
  notarization through an App Store Connect API key. Gatekeeper checks these.
- The updater's: a minisign key whose public half is in `src-tauri/tauri.conf.json`.
  Installed apps refuse an update archive or catalog without it, whatever the Apple
  signature says. Updater signatures bind both the archive contents and the version.

The workflow reads these from the `release` environment, which only `v*` tags may
use and which requires the maintainer's approval:

| Secret | Contents |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application certificate and private key, `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | Password of that `.p12` |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_API_KEY_P8` | Contents of the `AuthKey_<id>.p8` file |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater private key (repository secret) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password, empty for the current key |

Owner-only local copies live in `~/.config/kelvo/release/` (`updater.key`,
`AuthKey_<id>.p8`) and the login keychain (the Developer ID identity, and the
`statglass-notary` notarytool profile). Back up the updater key and an exported `.p12`
outside the Mac. Never commit them or print them in CI logs. Losing the updater key
prevents updates to existing installations; replacing it requires a planned
transition. The Developer ID certificate expires on 2027-12-08: create a new one
before then and replace `APPLE_CERTIFICATE`. Releases signed before expiry keep
working because their signatures are timestamped.

## Local release build (fallback)

When GitHub Actions is unavailable, the same build runs on the maintainer's Mac with
the local copies above. `target/release-assets` must be empty first; move a previous
deliverable aside rather than mixing releases. Use the actual version and tag.

```sh
TAURI_SIGNING_PRIVATE_KEY="$HOME/.config/kelvo/release/updater.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' \
APPLE_API_KEY=9WT3GZJQPY \
APPLE_API_ISSUER="<issuer ID from App Store Connect, Users and Access, Integrations>" \
APPLE_API_KEY_PATH="$HOME/.config/kelvo/release/AuthKey_9WT3GZJQPY.p8" \
bun run build:app --config src-tauri/tauri.release.conf.json --bundles app,dmg
NOTARY_PROFILE=statglass-notary scripts/notarize-dmg.sh
python3 scripts/release-manifest.py vX.Y.Z --stage
bun run tauri signer sign --private-key-path "$HOME/.config/kelvo/release/updater.key" \
  --password '' --app-version X.Y.Z target/release-assets/statglass-release.json
python3 scripts/release-manifest.py vX.Y.Z --checksums
cargo run -p statglass --example verify_release -- target/release-assets
gh release create vX.Y.Z target/release-assets/* --verify-tag --draft \
  --title "StatGlass vX.Y.Z" --notes-file RELEASE_NOTES.md
```

Without the `APPLE_API_*` variables, `tauri build` still signs with the Developer ID
but skips notarization without failing; `notarize-dmg.sh` catches that and stops.
For restart behavior outside a published update, `cargo build -p statglass --example
verify_update_restart` followed by `python3 scripts/verify-update-restart.py` checks
ordinary, background and remote-setup launches in isolation.

Ordinary local builds (`scripts/build-local.sh`, `bun run build:app`) stay ad-hoc
signed and need no keys.

## Update behavior

Automatic checking and installation are host-owned preferences. Existing disabled
checks remain disabled. Stable releases install automatically only when their signed
protocol range retains every protocol version supported by the installed release.
Explicit checks still work with automatic checks disabled.

The Mac app downloads verified releases and waits until interactive windows are hidden
and maintenance has finished before installing and restarting. Ambient boards do not
block installation; editing does. Automatic installation never elevates privileges;
Settings offers manual installation when authorization is required. Debug, benchmark
and App Store builds keep their existing exclusions. The app flushes history through
its normal restart lifecycle.

Linux system/user installations include a daily systemd update timer with startup
checking and jitter. The updater verifies and stages before stopping collection,
tests the candidate privately, then commits before exposing history to controllers.
Interrupted trials restore the previous installation; committed updates never roll
history back. Update policy and results are visible through the agent CLI and Hosts.
The collector sandbox and service limits remain in effect.

Existing Macs need one update through Install and restart, and legacy Linux agents
need one Update agent action to acquire this capability. Hosts need outbound HTTPS
access. Incompatible releases wait for a coordinated manual upgrade. Do not run an
older controller's direct install scripts concurrently with the host-owned updater;
only updater-capable controllers share its transaction lock.

## Coordinated protocol upgrades

When a release drops a protocol that an installed host supports, StatGlass leaves it
pending. Repeating **Update agent** does not override this protection. Upgrade the
controllers first, and schedule a monitoring interruption for each affected host.

For a remote Mac, quit StatGlass and install the newer signed release from its DMG.
Its existing app data remains in place. Open it and confirm the host reconnects.

For Linux, use the updated controller's bundled agent through Add host:

1. On the host, disable and stop `statglass-agent-update.timer`, stop
   `statglass-agent-update.service` (allow its recovery to finish), then stop
   `statglass-agent.service`. Use `systemctl --user` for a user installation or
   `systemctl` as root for a system installation.
2. Keep an offline backup of the entire data directory, installed executable and
   service units. System data is `/var/lib/statglass-agent`; user data is normally
   `~/.local/state/statglass-agent` and may follow `XDG_STATE_HOME`. Record the host
   identity, history epoch and configured paths before proceeding.
3. Run `statglass-agent uninstall` in its installation account, with `--system` for a
   system installation. **Do not pass `--purge`.** Confirm that uninstallation
   succeeds and the data, settings and `host-id` remain. Keep the backup outside
   the installation's data directory.
4. Remove the saved connection from the controller with all removal options
   unchecked, keeping the mirrored history. Use Add host and install the newer bundled agent
   under the same account and scope. The installer reuses the retained data and
   identity. Confirm the identity, history, settings and connection before
   re-enabling the desired automatic-update preferences.

This explicit reinstall is outside the automatic transaction's rollback guarantee.
If the new daemon has exposed public history, never restore an older database under
the same history epoch: controllers may already hold newer cursors. Resolve a
post-start failure with a forward fix. Keep the offline backup for investigation;
do not silently overwrite the current database with it.
