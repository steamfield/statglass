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
| a | S | crates/statglass-remote/src/ssh_config.rs, crates/statglass-remote/tests/ssh_config.rs, plan/decisions.md | contracts | crates/statglass-remote/tests/ssh_config.rs | opus | pending | | ssh_config tests pass, revert-verified |

#### Lane a brief

Inline by the orchestrator. Classify with `statglass_session::network::classify_address` (one predicate, `is_tailnet`, for both the LanLiteral exemption and the relabel), label such a route `BundleRoute::Tailscale`, and dedupe targets by host. Update the pinned `cgnat` case in `rejects_unavailable_routes_in_the_required_precedence` and add the cases above. Record the decision in `plan/decisions.md`.

### Phase 2: the handover is visible and findable

Demo: browser dev server on the mock transport. Settings › Paired devices › Pair iPhone, then the mock phone approves: the dialog lists included and unavailable hosts. Hosts page: "Add to iPhone" opens Update from Mac (paired) or Pair iPhone (no phone). In the simulator, the phone's Add a host screen shows the new copy.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-remote/src/pairing.rs, src-tauri/src/pairing/status.rs, src-tauri/src/pairing.rs, src/app/routes/dashboard/settings/_components/paired-devices/pairing-offer-view.tsx, src/app/routes/dashboard/settings/_components/paired-devices/pairing.test.tsx, packages/core/src/mock/pairing.ts, packages/core/src/mock/handover.ts, packages/core/src/mock-transport.ts, packages/core/src/mock-transport.test.ts | contracts, src/app/routes/dashboard/settings/_components/handover-host-lists.tsx | | opus | pending | | brief's tests pass, bindings-check clean |
| b | M | packages/core/src/query-keys.ts, src/app/routes/dashboard/settings/_components/paired-devices/panel.tsx, src/app/routes/dashboard/hosts/route.tsx, src/app/routes/dashboard/hosts/route.test.tsx, src/app/routes/dashboard/hosts/_components/add-to-iphone.tsx, src/app/routes/dashboard/hosts/_components/add-to-iphone.test.tsx, src/app/routes/dashboard/settings/_components/update-from-mac/index.tsx, src/app/routes/dashboard/settings/_components/update-from-mac/update-from-mac.test.tsx, src/app/routes/dashboard/settings/_components/paired-devices/pairing-dialog.tsx | contracts, src/app/routes/dashboard/settings/_components/paired-devices/panel.tsx | | opus | pending | | brief's tests pass |
| c | S | apps/mobile/src/pairing/screens/choose-method.tsx, apps/mobile/src/pairing/help/, apps/mobile/test/pairing/, docs-site/src/content/docs/iphone.md, docs-site/src/content/docs/linux-hosts.md | contracts | | sonnet | pending | | brief's tests pass, mobile-check clean |

(Briefs written while phase 1 runs.)

## Log

- 2026-11-26: Diagnosis. `/Applications/StatGlass.app` 0.15.0 lacks `src-tauri/src/handover/` (`git cat-file -e v0.15.0:src-tauri/src/handover/bundle.rs` fails); handover landed on main after the tag. No `device-intents.jsonl` was ever written. The scratch diagnostic using the shipped `handover_host` resolved m1-linux, M4 Mini and Plex Server and refused Live Oak as `LanLiteral` (100.102.228.126).
- Plan critique (devils-advocate, 8 findings). Applied: 1 (truncation fallback: Mac-side summary with `dropped`, kept on the offer), 2 (summary excludes this Mac by construction; `HandingOver` returns `Waiting` mid-approval, which lane 2a must keep from flipping the dialog back to the QR), 4 (reuse `classify_address`), 5 (dedupe targets; the phone's display record keeps the first target per route, accepted as display-only), 6 (lane 2a owns the mock handover wiring), 7 (lane 2b owns the paired-devices query key move to `@core/query-keys`, loading/error states named), 8 (D-136 reference; phase 1 tests). Accepted without change: 3 (intent-log failures reported as `Unresolvable`; a new reason is a wire change for a local-disk failure). Release order: 0.16.0 on main lacks phase 1; the report tells the user.
- Phase 2 tests are written by the lanes from the case lists in their briefs, rather than in the scaffold. These are small UI and status changes, and the cases are listed in full; reviewed per lane.
