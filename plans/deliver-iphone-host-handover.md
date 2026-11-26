# Plan: iPhone host handover, fixed and findable

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.4/shared/scripts/plan_graph.py
Started: 2026-11-26. Timebox: none. Landing branch: deliver/iphone-host-handover.
Worktree: /Users/riley/Projects/statglass-wt-handover
Gate: `make rust-check bindings-check architecture-check && cargo test -p statglass-remote -p statglass && bun run check && make mobile-check`. Filtered tests: `cargo test -p <crate> <filter>`, `bun run test -- <path>`, `bun run --cwd apps/mobile test -- <path>`. Typecheck: `bun run typecheck`.
Commits: conventional commit subjects are enforced by the commit hook (`type(scope): subject`).
Runner: plain commands.
Worktree setup: `bun install --frozen-lockfile`.
Executors: phase 1 inline (orchestrator). Phase 2 lanes are foreman Codex runs (gpt-6.2-sol, high effort), one per lane, with contracts built from the lane brief and `.claude/delegate.md`. A run leaves its work uncommitted; the orchestrator reviews the diff, commits it on the lane branch, runs `check-lane` and a lane review, then merges.

## Spec

Pairing an iPhone with a Mac is supposed to bring along every remote host that Mac monitors (RFC `plan/rfc-ios-app.md` §2.4). The user's phone got only the laptop. Diagnosis: the installed 0.15.0 was tagged before handover reached main, so it couldn't send anything. Running the shipped resolver against the real saved hosts also turned up a bug: a host whose only alias resolves to a Tailscale 100.64/10 address is refused as `LanLiteral`. The release that is already prepared on main (0.16.0) carries handover. This plan fixes the CGNAT rule, shows on the Mac which hosts were handed over, and makes the path findable from the Hosts page, the phone and the docs.

In scope:
- Handover treats a hostname in 100.64.0.0/10 or fd7a:115c:a1e0::/48 as a Tailscale route: it is never `LanLiteral`, and its bundle target is labelled `tailscale` even when it came from the LAN alias slot (user decision 2026-11-26).
- After approval, the Mac's pairing dialog lists the hosts handed over and the ones that couldn't be, with reasons.
- The Hosts page gets an "Add to iPhone" action: Update from Mac when a phone is paired, Pair iPhone when none is.
- The phone's Add a host copy and the iPhone docs explain the Mac hub, Update from Mac and `statglass-agent pair` for headless Linux.

Out of scope: per-host QR codes, ProxyJump on the phone, host-list push over the session, a phone-side "no hosts shared" line (it needs a new `PairedHost` field and an XCFramework rebuild; the Mac summary covers the silent-failure case), and cutting the release itself, which the user does with `scripts/release.sh`.

Assumptions: a 100.64/10 address in an SSH config is a tailnet peer, not carrier NAT. D-136's interface-based check for carrier NAT on the local Mac is unaffected.

Error model: `PairingStatus::Paired` gains the Mac-side handover summary: names of hosts handed over (never this Mac), unavailable hosts with their `HandoverReason`, and `dropped`, true when the reply didn't fit the pair frame and `add_handover` fell back to this Mac alone. The summary comes from the `Handover` the source returned, kept on the offer (Mac-only, not on the wire), not from the reply. Empty lists mean no handover source or no saved hosts. `dropped` tells the user the iPhone got only this Mac and to use Update iPhone, because the intents for those hosts were already recorded. An intent-log write failure stays reported as `Unresolvable` (critique 3, accepted: a new reason is a wire change) and is logged at warn. The Hosts action shows the existing dialogs' own errors; while `pairedDevices` loads it is disabled, and on error it opens Pair iPhone, which shows its own failure.

## Contracts (scaffold commit, phase 2)

    src-tauri/src/pairing/status.rs                    PairingStatus::Paired { device, hosts: Vec<String>, unavailable: Vec<HandoverUnavailableInfo>, dropped: bool }; From<PairReply> stubs empty/false
    packages/core/src/generated/types.ts               regenerated (make bindings)
    src/desktop-transport/commands.ts                  regenerated
    packages/core/src/mock/pairing.ts                  paired status with empty lists, so it typechecks
    src/app/routes/dashboard/settings/_components/handover-host-lists.tsx   HostLists moved out of update-from-mac/index.tsx, exported; pure presentation

## Phases

### Phase 1: CGNAT routes hand over as Tailscale (MVP)

Scaffold: 278782bc
Tag: handover-phase-1

Demo: the scratch diagnostic (`scratchpad/handover-diag`) prints OK for all four of the user's saved hosts, Live Oak included, with Live Oak's target labelled tailscale.
Test cases:
- LAN alias resolving to 100.127.8.9 with no Tailscale alias: Ok, one target, route tailscale.
- LAN alias resolving to fd7a:115c:a1e0::1 with no Tailscale alias: Ok, route tailscale.
- 10.0.1.5 and fe80::1%en0 LAN-only stay `LanLiteral` (regression guard).
- 100.63.255.255 and 100.128.0.1 (outside the block) LAN-only: 100.63.x is public, so it hands over as lan and needs a key; 100.128.0.1 is public too.
- A CGNAT LAN alias plus a Tailscale alias: both targets labelled tailscale, in alias order.
- Two aliases resolving to the same address: one target.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | S | crates/statglass-remote/src/ssh_config.rs, crates/statglass-remote/tests/ssh_config.rs, plan/decisions.md | contracts | crates/statglass-remote/tests/ssh_config.rs | opus | merged | | ssh_config tests pass, revert-verified |

#### Lane a brief

Inline by the orchestrator. Classify with `statglass_session::network::classify_address` (one predicate, `is_tailnet`, for both the LanLiteral exemption and the relabel), label such a route `BundleRoute::Tailscale`, and dedupe targets by host. Update the pinned `cgnat` case in `rejects_unavailable_routes_in_the_required_precedence` and add the cases above. Record the decision in `plan/decisions.md`.

### Phase 2: the handover is visible and findable

Demo: browser dev server on the mock transport. Settings › Paired devices › Pair iPhone, then the mock phone approves: the dialog lists included and unavailable hosts. Hosts page: "Add to iPhone" opens Update from Mac (paired) or Pair iPhone (no phone). In the simulator, the phone's Add a host screen shows the new copy.
Depends on: phase 1
Scaffold: d2e54b9a

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-remote/src/pairing.rs, src-tauri/src/pairing/status.rs, src-tauri/src/pairing.rs, src/app/routes/dashboard/settings/_components/paired-devices/pairing-offer-view.tsx, src/app/routes/dashboard/settings/_components/paired-devices/pairing.test.tsx, packages/core/src/mock/pairing.ts, packages/core/src/mock/handover.ts, packages/core/src/mock-transport.ts, packages/core/src/mock-transport.test.ts, packages/core/src/generated/types.ts, src/desktop-transport/commands.ts | contracts, src/app/routes/dashboard/settings/_components/handover-host-lists.tsx | | opus | merged | foreman/handover-2a | brief's tests pass, bindings-check clean |
| b | M | packages/core/src/query-keys.ts, src/app/routes/dashboard/settings/_components/paired-devices/panel.tsx, src/app/routes/dashboard/hosts/route.tsx, src/app/routes/dashboard/hosts/route.test.tsx, src/app/routes/dashboard/hosts/_components/add-to-iphone.tsx, src/app/routes/dashboard/hosts/_components/add-to-iphone.test.tsx, src/app/routes/dashboard/settings/_components/update-from-mac/index.tsx, src/app/routes/dashboard/settings/_components/update-from-mac/update-from-mac.test.tsx, src/app/routes/dashboard/settings/_components/paired-devices/pairing-dialog.tsx | contracts, src/app/routes/dashboard/settings/_components/paired-devices/panel.tsx | | opus | merged | foreman/handover-2b | brief's tests pass |
| c | S | apps/mobile/src/pairing/screens/choose-method.tsx, apps/mobile/src/pairing/help/, apps/mobile/test/pairing/, docs-site/src/content/docs/iphone.md, docs-site/src/content/docs/linux-hosts.md | contracts | | sonnet | merged | foreman/handover-2c | brief's tests pass, mobile-check clean |

#### Lane a brief (Mac approval summary)

- Goal: after the user approves a phone in Settings › Paired devices › Pair iPhone, the dialog says which of this Mac's hosts went to the iPhone and which couldn't, so a handover that sent nothing is visible on the Mac.
- Interface: `PairingStatus::Paired { device, hosts: Vec<String>, unavailable: Vec<HandoverUnavailableInfo>, dropped: bool }` (scaffold, `src-tauri/src/pairing/status.rs`). `HandoverUnavailableInfo` and its `From<UnavailableHost>` are in `src-tauri/src/handover.rs` (read-only). `HostLists` from `src/app/routes/dashboard/settings/_components/handover-host-lists.tsx` (read-only) renders the lists.
- Behavior:
  - `PairingHost::approve` (`crates/statglass-remote/src/pairing.rs`) keeps the `Handover` the source returned on the offer, Mac-side only (never in `PairReply` or on the wire), plus `dropped = true` when `add_handover` falls back to this Mac alone because the reply didn't fit. Every later status poll and late retry of that offer returns the same summary.
  - Mapping to `PairingStatus::Paired`: `hosts` = names of the handed-over hosts (the source's list, which never contains this Mac), `unavailable` = the source's unavailable list, `dropped` as above. No handover source: empty lists, `dropped: false`.
  - Dialog, paired state: "iPhone paired." then `HostLists` with `hosts`/`unavailable`. Its empty text ("No other hosts are included.") shows only when this Mac has saved remote hosts, or always; pick the simpler, and say which. `dropped`: an InlineMessage (tone note) "The host list was too large to send while pairing. On your iPhone, open Update from Mac to add the other hosts." in place of the lists.
  - While approve is in flight, the dialog keeps showing the pending device (name, model, code) with Approve and Deny disabled. A concurrent status poll that returns `waiting` (the offer's `HandingOver` phase) must not flip the view back to the QR.
  - Mock: `createMockHandover`'s `onApprove` returns the summary (hosts `build-server`, `Lab Mini`; one unavailable host `Office server` with reason `lan_literal`), and the mock `pairingApprove`/`pairingStatus` return it in the paired status. Keep the existing intents behavior.
- Tests to write: Rust unit tests in `crates/statglass-remote/src/pairing.rs` tests: summary present on the approved offer, kept across a later status call, `dropped` set when a large handover truncates (reuse the existing oversized-handover test fixture if there is one), no source gives empty. `src-tauri` mapping test in `status.rs` or `pairing.rs` tests. Vitest in `pairing.test.tsx`: approved shows included and unavailable hosts with reason text; `dropped` shows the note and no lists; a `waiting` poll during approval keeps the pending view. `mock-transport.test.ts` updated for the summary.
- Decisions already made: no new `HandoverReason`; intent-log failures stay `Unresolvable`. No wire change.
- Out of scope: the Hosts page, Update from Mac, the phone.
- Done when: `cargo test -p statglass-remote pairing`, `cargo test -p statglass pairing`, `bun run test -- src/app/routes/dashboard/settings packages/core/src/mock-transport.test.ts`, `bun run typecheck`, `make bindings-check`, `cargo clippy -p statglass-remote -p statglass --all-targets -- -D warnings` pass.

#### Lane b brief (Hosts page "Add to iPhone")

- Goal: the Hosts page offers a direct way to put this Mac's hosts on the iPhone.
- Interface: new `AddToIphone` in `src/app/routes/dashboard/hosts/_components/add-to-iphone.tsx`, rendered in the Hosts `PageHeader` actions before "Add host" as an outline button labelled "Add to iPhone". `PairingDialog` and `UpdateFromMac` gain an optional controlled mode (`open`, `onOpenChange`, and no built-in trigger when controlled) so the Hosts page can open them without their Settings triggers; their Settings rendering is unchanged. Move the paired-devices query key out of `panel.tsx` into `@core/query-keys` (follow that file's existing pattern and naming) and use it in both places.
- Behavior:
  - Paired devices known and non-empty: the button opens the Update from Mac dialog.
  - None paired: it opens the Pair iPhone dialog; after a pairing completes, the devices query is invalidated (as Settings does) so the next click opens Update from Mac.
  - While `pairedDevices` is loading the button is disabled; if it errors, the button opens Pair iPhone, which shows its own failure (for example Remote Login off or monitoring off).
  - Show the button only when the Mac has at least one saved remote host (`useRemoteHosts` data non-empty); with none there is nothing to hand over.
- Tests to write: `add-to-iphone.test.tsx` with the mock transport: no devices opens Pair iPhone; a device opens Update from Mac (QR and included hosts visible); loading disabled; no remote hosts hides it. `route.test.tsx`: the button sits in the header. `update-from-mac.test.tsx`: the Settings row still opens it (existing tests keep passing).
- Decisions already made: reuse the dialogs; no new flow, copy or state machine.
- Out of scope: approval summary (lane a), the phone, styling outside the button.
- Done when: `bun run test -- src/app/routes/dashboard/hosts src/app/routes/dashboard/settings`, `bun run typecheck`, `bunx biome check src packages/core/src` pass.

#### Lane c brief (phone copy and docs)

- Goal: a user adding hosts on the iPhone learns that pairing with a Mac brings all of that Mac's hosts, and how to add a Linux host that no Mac monitors.
- Interface: `ChooseMethod` (`apps/mobile/src/pairing/screens/choose-method.tsx`) and `SetupGuidance` (`apps/mobile/src/pairing/help/`).
- Behavior:
  - `ChooseMethod` explanation: "Create the code on a Mac running StatGlass to add it and the hosts it monitors, or on a Linux host running the agent." (Keep it one sentence; adjust wording to fit the screen's voice.)
  - `SetupGuidance` gains, or rewords to include: on a Mac, Settings › Paired devices › Pair iPhone, and that the Mac also shares its other hosts; for hosts added on the Mac later, Settings › Update from Mac on the iPhone; for a Linux host with no Mac, run `statglass-agent pair` on it over SSH and scan the QR printed in the terminal (or paste the text).
  - Docs `iphone.md` "Pair a host" gains a short subsection "Hosts from your Mac": pairing with a Mac offers its saved remote hosts; Update from Mac for later additions; which hosts can't be shared and why (an alias using ProxyJump or ProxyCommand, a host reachable only at a LAN address with no Tailscale route, no saved host key in `known_hosts`); tailnet addresses (100.x) count as Tailscale. `linux-hosts.md` gets one line pointing at `statglass-agent pair` for adding the host to an iPhone.
- Tests to write: update or add jest tests under `apps/mobile/test/pairing/` asserting the new copy renders (follow the existing tests there).
- Decisions already made: copy only; no new screens, routes or native calls. Follow `rules/mobile/expo.md` (Text roles, no colour literals).
- Out of scope: the "no hosts shared" post-pair line, Rust, the desktop.
- Done when: `bun run --cwd apps/mobile test -- pairing`, `make mobile-check` pass.

## Log

- 2026-11-26: Diagnosis. `/Applications/StatGlass.app` 0.15.0 lacks `src-tauri/src/handover/` (`git cat-file -e v0.15.0:src-tauri/src/handover/bundle.rs` fails); handover landed on main after the tag. No `device-intents.jsonl` was ever written. The scratch diagnostic using the shipped `handover_host` resolved m1-linux, M4 Mini and Plex Server and refused Live Oak as `LanLiteral` (100.102.228.126).
- Plan critique (devils-advocate, 8 findings). Applied: 1 (truncation fallback: Mac-side summary with `dropped`, kept on the offer), 2 (summary excludes this Mac by construction; `HandingOver` returns `Waiting` mid-approval, which lane 2a must keep from flipping the dialog back to the QR), 4 (reuse `classify_address`), 5 (dedupe targets; the phone's display record keeps the first target per route, accepted as display-only), 6 (lane 2a owns the mock handover wiring), 7 (lane 2b owns the paired-devices query key move to `@core/query-keys`, loading/error states named), 8 (D-136 reference; phase 1 tests). Accepted without change: 3 (intent-log failures reported as `Unresolvable`; a new reason is a wire change for a local-disk failure). Release order: 0.16.0 on main lacks phase 1; the report tells the user.
- Phase 1 boundary review (4 findings, all fixed in 721ddcc6): dedupe dropped a Tailscale label on a shared host, compared raw strings, no 100.128.0.1 edge case, redundant tailnet check. Both new guards revert-verified (label upgrade disabled; mask loosened to `second >= 64`). Tagged handover-phase-1.
- Phase 2 tests are written by the lanes from the case lists in their briefs, rather than in the scaffold. These are small UI and status changes, and the cases are listed in full; reviewed per lane.
