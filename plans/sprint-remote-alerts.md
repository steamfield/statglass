# Plan: remote alert rules

Status: running. Skill: sprint. Profile: sprint. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.4/shared/scripts/plan_graph.py
Started: 1795574260. Timebox: none. Landing branch: sprint/remote-alerts.
Gate: `make check` (405 s). Filtered tests: `cargo test -p <crate> <name filter>` and `bun run test -- <path>`. Typecheck: `cargo check --workspace --all-targets` and `bun run typecheck`.
Runner: plain commands. Lanes are Codex runs through foreman (model gpt-6.2-sol), one managed worktree each at `.claude/worktrees/<run>` on `foreman/<run>`, cut from the phase scaffold. Codex leaves its work uncommitted; the orchestrator reviews it, runs `check-lane`, commits on the lane branch and merges. Lane tests are written by the lane (the scaffold carries the test-case list, not test files).
Worktree setup: `bun install --frozen-lockfile`.
Suppressions: biome-ignore, #[allow(, #[expect(
Manifests: Cargo.toml, package.json

## Spec

Threshold alert rules for Linux agent hosts, set from this Mac's Alerts page with the host selected, evaluated by the agent's own engine and delivered by this Mac (notification and destinations) as the alert events sync in. Design and reasoning: `plan/rfc-remote-alerts.md` (revision 3) and D-140 in `plan/decisions.md`.

In scope: RFC sections 3 to 5 and the section 8 decisions. Two host queries (`AlertRules`, `SetAlertRules`) with per-rule encoding; agent live apply under a mutex with a content revision; `drop_invalid` on agent load; cooldown seeding at start and on history reattach; `recent_alerts` moved into the engine; `mem.psi` and `cpu.loadavg` in `ALERT_METRICS`; delivery of inserted alert events with a per-host floor, staleness on this Mac's clock and a grouped catch-up message past 10 minutes; the host name in the notification; the host-scoped Alerts page and its states; the mock.
Out of scope: RFC section 3's out list (remote Macs, agent self-delivery, built-in rules on agents, multi-host rules), live event forwarding, prefilling core counts.
Assumptions: Linux host = agent host (`HostInfo.os` / `SavedHost::is_linux`). The revision is FNV-1a 64 over the JSON encoding of the rule list, masked to 53 bits, so it is stable across agent restarts and crosses to TS as a number. A rule this Mac cannot decode is listed by id only and kept on save through `keep`; a rule the agent cannot decode is refused there.
Error model: host side, every refusal is `Answer::Error { code, message }`: `Stale` (new `ErrorCode`, older peers read it as `Unknown`) for a revision mismatch, `InvalidArgument` for an undecodable or invalid rule (message is the `AlertRuleError` text), `Internal` for a failed `settings.json` write (the engine keeps its old rules), `Unsupported` from a host that does not answer these queries (the Mac app, old agents). Controller side, `RemoteSource::call` errors and refusals map to `CommandError` (phase 2 picks variants per RFC 5.6). Delivery failures use the existing `DeliveryOutcome`. Nothing is swallowed: a failed seed read logs and starts cooldowns fresh, a failed floor read logs and restarts the floor at now.

## Contracts (scaffold commit)

    crates/statglass-proto/src/alert_rules.rs   HostAlertRules, RuleEntry (per-rule lenient decode); wire types only
    crates/statglass-proto/src/query.rs          Query::AlertRules, Query::SetAlertRules, Answer::AlertRules
    crates/statglass-proto/src/message.rs        ErrorCode::Stale
    crates/statglass-remote/src/host_server.rs   ServedHost::alert_rules / set_alert_rules, defaulting to Unsupported
    crates/statglass-remote/src/host_queries.rs  dispatches the two queries to ServedHost
    crates/statglass-engine/src/alert_history.rs HistoryStore::recent_alerts / alerts_since (moved from src-tauri/src/history.rs)
    crates/statglass-agent/src/alert_rules.rs    new in lane 1/b: the agent's rule store (revision, replace, write, apply)

Wire (one-way door):

```rust
pub struct HostAlertRules { pub revision: i64, pub rules: Vec<RuleEntry> }
#[serde(untagged)] pub enum RuleEntry { Known(AlertRule), Unknown(ciborium::Value) }
Query::AlertRules
Query::SetAlertRules { base_revision: i64, rules: Vec<RuleEntry>, keep: Vec<Uuid> }
Answer::AlertRules(HostAlertRules)   // both queries answer with the rules now in force
```

## Phases

### Phase 1: agents accept, store and evaluate rules (MVP)

Demo: `cargo test -p statglass-agent alert_rules` and `cargo test -p statglass-proto --test alert_rules` (check the test count is non-zero): an agent answers `AlertRules`, takes `SetAlertRules`, persists to `settings.json`, refuses a stale revision, and its engine fires the new rule without a restart.
Checkpoint: none (no timebox).
Scaffold: 1d3f4a53
Tag: remote-alerts-phase-1
Test cases:
- `RuleEntry` round-trips a known rule through CBOR; an entry with an unknown condition decodes as `Unknown` and re-encodes byte-identical; a list with one unknown entry still decodes the rest.
- `Query::SetAlertRules` and `Answer::AlertRules` round-trip; an old-build fixture without these kinds decodes them as `Unknown` (skew both ways, following `tests/forward_compat.rs`).
- `ErrorCode::Stale` decodes as `Unknown` on a build that lacks it (the `serde(other)` path).
- A host that keeps the `ServedHost` defaults answers both queries with `Unsupported`.
- Agent: `alert_rules` returns the loaded rules and a revision; the revision is equal for equal lists and changes when any rule changes.
- Agent: `set_alert_rules` with a matching revision writes `alerts.rules` into `settings.json` (other keys untouched), applies live, and returns the new list and revision.
- Agent: stale revision answers `Stale` and changes nothing; an invalid rule answers `InvalidArgument` with the `AlertRuleError` text and changes nothing; an `Unknown` entry answers `InvalidArgument`; a failed write answers `Internal` and the engine keeps the old rules.
- Agent: `keep` ids retain the existing rules with those ids, after the sent rules; ids not present are ignored.
- Agent: two concurrent sets with the same base revision: exactly one succeeds, the other answers `Stale`.
- Agent: `settings::load` drops an invalid rule with a warning and keeps the valid ones.
- Agent: cooldown seeding at start from stored alerts; on reattach of a history that was unavailable at start, the engine is seeded from it.
- Live apply: a rule set through `set_alert_rules` fires on the engine's next qualifying ticks (fake ticker), with no restart.
- `ALERT_METRICS` gains `mem.psi` ("Memory stall", >, 10, 120 s, 0.01..100, label stall=some) and `cpu.loadavg` ("Load average", >, 4, 300 s, 0.1..1000, label window=5); `entries_match_the_catalog` passes; rule sentences in `src/core/alerts.ts` read naturally for both labels.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-proto/src/alert_rules.rs, crates/statglass-proto/tests/alert_rules.rs, crates/statglass-proto/tests/fixtures/, crates/statglass-remote/src/host_queries.rs, crates/statglass-schema/src/alert_metrics.rs, src/core/generated/, src/core/alerts.ts, src/core/alerts.test.ts, src/app/routes/dashboard/alerts/_lib/rule-form.test.ts, src/app/routes/dashboard/alerts/_components/rule-dialog.test.tsx, src/core/alert-values.ts, crates/statglass-schema/src/alert_limits.rs, crates/statglass-notify/src/text.rs, crates/statglass-notify/src/units.rs, crates/statglass-notify/tests/text.rs | contracts, crates/statglass-proto/tests/forward_compat.rs | | gpt-6.2-sol | merged | foreman/ra-1a | wire and metric tests pass, bindings fresh |
| b | M | crates/statglass-agent/src/alert_rules.rs, crates/statglass-agent/src/lib.rs, crates/statglass-agent/src/host.rs, crates/statglass-agent/src/settings.rs, crates/statglass-agent/src/daemon.rs, crates/statglass-agent/src/commands.rs, crates/statglass-agent/src/alert_rules_tests.rs, crates/statglass-engine/src/engine/control.rs, crates/statglass-engine/src/inbox.rs, crates/statglass-engine/src/engine.rs, crates/statglass-engine/src/engine/alert_tests.rs | contracts, src-tauri/src/state.rs (seeding pattern) | | gpt-6.2-sol | merged | foreman/ra-1b | agent tests pass |

#### Lane a brief

- Goal: prove the wire contract and make the two new metrics alertable.
- Interface: `statglass_proto::{HostAlertRules, RuleEntry}`, `Query::{AlertRules, SetAlertRules}`, `Answer::AlertRules`, `ErrorCode::Stale` (scaffold); `ServedHost` defaults and dispatch in `host_queries.rs` (scaffold); `ALERT_METRICS` in `statglass-schema`.
- Behavior: the proto, codec, skew and Unsupported test cases above, plus the `ALERT_METRICS` case. Regenerate bindings with `make bindings`. `src/core/alerts.ts` describes a `stall=some` series as plain "Memory stall" and `window=5` as "Load average (5 min)" or the file's equivalent pattern; follow how it handles the `vol` label today.
- Decisions already made: the wire shapes in Contracts are fixed; do not rename or reshape them. Defaults as listed.
- Out of scope: the agent, the controller, the Alerts page beyond rule sentences.
- Done when: `cargo test -p statglass-proto`, `cargo test -p statglass-remote host_queries`, `cargo test -p statglass-schema alert`, `bun run test -- src/core/alerts.test.ts src/app/routes/dashboard/alerts`, `make bindings-check`, typechecks.

#### Lane b brief

- Goal: the agent owns, persists and live-applies its rules, and keeps cooldowns across restarts.
- Interface: implement `ServedHost::alert_rules` / `set_alert_rules` for `AgentHost`, backed by `crate::alert_rules` (a new module lane b creates and declares in `lib.rs`: `rules_revision(&[AlertRule]) -> i64`, and an `AlertRuleStore` holding the data directory, the current `Settings` and a mutex). `AgentHost::start` gains the data directory (`Option<PathBuf>`; `commands.rs` sample passes `None`, which keeps the Unsupported defaults) and the seed events. Add `EngineControl::seed_alert_history(Vec<Event>)` as a new `Command` so a running engine can be seeded on reattach. Use `HistoryStore::recent_alerts` (scaffold).
- Behavior: the agent test cases above. `set_alert_rules` steps, under one mutex: revision check, refuse `Unknown` entries, build known-then-kept list, `AlertSettings::validate`, write `alerts.rules` through `settings::configure` (array replaced whole), then `apply_settings` with the in-memory `Settings` with only `alerts.rules` replaced (never what `configure` returned). Messages: Stale "The alert rules on this host changed. Reload them and try again."; unknown entry "This agent does not know one of these rules. Update the agent."; write failure "Saving the alert rules: <cause>".
- Decisions already made: FNV-1a 64 over `serde_json::to_vec(rules)`, masked to 53 bits. The CLI `configure` race is accepted (RFC 5.1).
- Out of scope: built-in rules and host-offline on agents, anything in `src-tauri`.
- Done when: `cargo test -p statglass-agent` and `cargo test -p statglass-engine seed` pass, clippy clean.

### Phase 2: this Mac sets rules and delivers remote alerts

Demo: `cargo test -p statglass remote_delivery`, `cargo test -p statglass remote_rules` and `cargo test -p statglass-remote alert` (non-zero counts): commands read and replace a fake agent's rules with each refusal mapped; inserted alert events from a mirrored page are delivered once, back history is Timeline-only, late ones go out as one catch-up message.
Depends on: phase 1
Scaffold: ffc76868
Tag: remote-alerts-phase-2
Phase scaffold (orchestrator, when phase 1 tags): `IngestReport.alerts_inserted: Vec<Event>` (always empty until lane a); `pub type AlertListener = Arc<dyn Fn(Uuid, Vec<Event>) + Send + Sync>` and `Mirror::set_alert_listener(&self, listener: AlertListener)`, with `Mirror::ingest` calling it after the durable commit when `alerts_inserted` is non-empty (epoch = the page's epoch); `RemoteError::Stale(String)`.
Test cases:
- Store: a page with two new alert events and one non-alert event reports exactly the two alerts in `alerts_inserted`, decoded; replaying the same page reports none; a same-source event updated with a higher `source_seq` is not reported as inserted.
- Mirror: the listener receives the page epoch and the inserted alerts once, only after the commit; a failed ingest calls nothing; no listener set is fine.
- Typed queries: `RemoteSource::alert_rules` / `set_alert_rules` map `Stale` to `RemoteError::Stale`, `Unsupported` to `Unsupported`, `InvalidArgument` to `InvalidArgument`, `Internal` to `Refused`.
- Commands: `remote_alert_rules(host)` returns `RemoteAlertRules { revision, rules, newer }` with undecodable entries listed in `newer` by id (an entry with no readable id is listed with `id: null`); `set_remote_alert_rules(host, base_revision, rules, keep)` sends known rules plus `keep`; refusals map to `CommandError`: not connected / timeout to the existing remote variants, `Stale` to a new `RemoteRulesChanged { message }`, `Unsupported` to `RemoteUnsupported`, `InvalidArgument` to `InvalidSettings`; a This Mac or remote-Mac host id is refused with `InvalidArgument` before any call.
- Delivery: only Linux hosts are delivered for. The first batch seen for a (host, epoch) sets that pair's floor to now on this Mac's clock and is Timeline-only; later inserted alerts at or after the floor are delivered. Event time is converted to this Mac's clock with the source's `HostClock` offset (host now minus local now); with no clock observation yet the event's own time is used. Fresh (at most 10 minutes old on this Mac's clock) alerts are announced one by one; older ones in the same batch become one catch-up notification and one destination message per host. Every inserted alert is published as `event-recorded`, delivered or not. The floor file is unreadable: log, floor restarts at now, nothing delivered twice. A floor survives a restart.
- Notification text: a remote host's alert notification names the host ("m1-linux: Free disk space below 20 GB" or the `statglass-notify` equivalent); This Mac's alerts read as today. Catch-up wording comes from `statglass-notify`: "While this Mac was away, m1-linux raised 3 alerts: <first rule>, <second rule>, and 1 more" (up to two names).

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | S | crates/statglass-store/src/writer/sync.rs, crates/statglass-store/tests/sync.rs, crates/statglass-remote/src/mirror.rs, crates/statglass-remote/tests/mirror_alerts.rs | contracts, crates/statglass-store/src/writer/mod.rs | | gpt-6.2-sol | merged | foreman/ra-2a | store and mirror alert tests pass |
| b | M | src-tauri/src/alerts/remote_delivery.rs, src-tauri/src/alerts/remote_delivery_tests.rs, src-tauri/src/alerts/mod.rs, src-tauri/src/alerts/fire.rs, src-tauri/src/notify.rs, crates/statglass-notify/src/text.rs, crates/statglass-notify/src/lib.rs, crates/statglass-notify/tests/text.rs, src-tauri/src/remote/registration.rs | contracts, src-tauri/src/alerts/host_offline.rs (a pure watch with its state) | | gpt-6.2-sol | merged | foreman/ra-2b | delivery tests pass |
| c | M | crates/statglass-remote/src/source/queries.rs, crates/statglass-remote/src/lib.rs, src-tauri/src/alerts/remote_rules.rs, src-tauri/src/alerts/remote_rules_tests.rs, src-tauri/src/alerts/commands.rs, src-tauri/src/remote.rs, src-tauri/src/error.rs, src-tauri/src/lib.rs, src/core/generated/, src/core/mock/commands.ts | contracts, crates/statglass-remote/src/source/queries.rs (usage_by_app pattern) | | gpt-6.2-sol | merged | foreman/ra-2c | command tests pass, bindings fresh |

The phase scaffold also declares `mod remote_delivery;` and `mod remote_rules;` in `src-tauri/src/alerts/mod.rs` with doc-only files, so lane c never edits `mod.rs`.

### Phase 3: the host-scoped Alerts page

Demo: `bun run dev:fast`, select the mock Linux host, open Alerts.
Depends on: phase 2

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | src/app/routes/dashboard/alerts/, src/app/routes/dashboard/route.tsx, src/app/routes/dashboard/_components/live-sidebar.tsx, src/core/alerts.ts, src/core/alerts.test.ts, src/core/remote-alert-rules.ts, src/core/mock/commands.ts, src/core/mock/fixtures.ts, src/core/mock/remote-alerts.ts, src/core/mock/remote-updates.ts, tests/e2e/remote-alerts.spec.ts | contracts, plan/design-system.md | | gpt-6.2-sol | pending | | page, mock, Vitest and Playwright pass; screenshots compared |
| b | M | (folded into a) | | | gpt-6.2-sol | cut | | |
| c | M | (covered by phase 2 tests) | | | gpt-6.2-sol | cut | | |

(Briefs written during phase 2.)

## Log
- Plan critique (sonnet DA): demo filter could run zero tests (fixed: `--test alert_rules`, count checked). `recent_alerts` move unfinished: rejected, `src-tauri/src/history.rs` delegates to the engine since the scaffold. Lanes span two capabilities: accepted deviation, lanes already running. Lane b tests on new metrics: steered to existing metrics. Golden revision test: added to lane b by steer. A newer-build rule with an extra field decodes as Known and loses the field on re-save: accepted limitation (agents update from this Mac, so the agent is rarely newer).
- 2026-11-24: User asked for test coverage per ce:writing-tests with the remote boundary mocked. Running phase 2 lanes get `tests-addendum.md` as a followup with their review fixes (fake peer over duplex, recording sender, fake clock, whole-result assertions, boundary cases, each test watched failing once). Added phase 3 lane c: cross-lane flow tests (a fake agent's synced page through the real Mirror, listener, delivery and floor to a recording sender; the rule commands against a fake peer). Phase 3 frontend lanes test through the mock transport plus one Playwright journey.
- 2026-11-24: User asked whether "no feature flag" was a misunderstanding (they expected a PostHog rollout flag). The flag RFC revision 3 dropped was a Hello capability bit in the wire handshake, not a rollout flag; it was dropped because remote Macs would also advertise it, and an old agent's `Unsupported` answer already gives the same signal (D-117). The repo has no PostHog or any telemetry, so no decision rested on it; D-140 stands.
- 2026-11-24: Phase 2 reviews found and fixed: first alert after pairing was Timeline-only (floor now set at registration); catch-up grouped per page instead of per pass; floors outlived host removal; repeated rule names in catch-up text; agent-clock fired_at; a newer build's added rule field stripped on save (Known now requires an exact CBOR round trip, D-140 amended); undecodable alerts dropped at debug level; a post-COMMIT read and a usage-flush failure that could store a page without reporting its alerts. Rejected for code: Rust-side refusal of saves with id-less newer entries (ids are a frozen wire field; the page disables saving instead); a separate error kind for Answer::Unknown (the page gates the update action on the host's agent_update status).
- 2026-11-24: Phase 3 is one lane: the mock and the page are coupled through the tests, so lane b is folded into a. Lane c is cut: lane 2b's tests drive a real SyncPage through the real Mirror, listener and Timeline path with only notification and destination sends faked, and lane 2c's tests drive both commands through a fake peer on the query wire.
