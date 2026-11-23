# Plan: alerts you set, delivered to your phone

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.0/shared/scripts/plan_graph.py
Started: 2026-11-23. Timebox: none. Landing branch: deliver/alerts (worktree /Users/riley/Projects/statglass/.claude/worktrees/deliver-alerts, cut from origin/main 6f2924fb).
Gate: `make rust-check && make architecture-check && cargo test -p statglass-schema -p statglass-notify -p statglass && cargo test -p statglass-engine --lib --test events && make bindings-check && bun run check` (about 4 min cold, frontend part 62 s). Filtered tests: `bun run test -- <path>` and `cargo test -p <crate> <name filter>`. Typecheck: `bun run typecheck` and `cargo check --workspace --all-targets`.
Runner: plain commands. Every cargo and make command, in this checkout and in lane worktrees, is prefixed with `CARGO_TARGET_DIR=/Users/riley/Projects/statglass/.claude/worktrees/deliver-alerts/target` so lanes share one build cache.
Worktree setup: `bun install --frozen-lockfile && make stub-dist`.
Suppressions: biome-ignore, #[allow(, #[expect(
Manifests: Cargo.toml, package.json

## Spec

The product and design decisions are in [plan/rfc-alerts.md](../plan/rfc-alerts.md); read it first. In short: users write their own threshold rules ("Memory pressure above 80% for 2 min") on a new Alerts page, every fired alert is a Timeline event, a macOS notification and a message to each enabled destination (ntfy or a webhook), and a built-in rule reports a saved host that stays offline.

In scope:
- Custom threshold rules stored in `Settings.alerts.rules`, validated in Rust, evaluated by the engine on the persisted tick.
- A Rust-published list of alertable metrics with defaults and ranges (`ALERT_METRICS`).
- Notification and message wording in a new `statglass-notify` crate.
- An Alerts page (rules, Send to, Recent) in the sidebar; the Alerts panel leaves Settings.
- Destinations (ntfy, webhook) in `alert-destinations.json`, delivered through `/usr/bin/curl`, with Send test and a last-delivery state.
- A built-in "saved host offline for 5 minutes" rule with a recovery notice.

Out of scope: threshold rules on remote hosts' metrics, agent-side evaluation, a history preview, per-rule routing, quiet hours, editing built-in rules, per-process or per-container custom rules, Pushover/Telegram/email kinds, notification click routing, a dev-gallery specimen (no shared component is added).

Assumptions (made without asking; the user delegated product calls):
- Rules live in Settings, destinations in their own 0600 file, because destinations hold secrets.
- Delivery shells out to curl with the request on stdin; no HTTP dependency is added.
- The Alerts page is hidden while a remote host is selected.
- No migration is needed: new `AlertSettings` fields default, the two built-in switches keep their stored values. An older build that opens the file ignores `rules` and drops them on its next save; accepted before v1.
- A stored rule this build cannot decode or that no longer validates is dropped on load with a warning; it never fails the settings load, which would reset every setting (`SettingsOwner::load_with_defaults`).

Error model: see RFC section 6.5. Rule validation runs on the patch path only: an `AlertRuleError` becomes `CommandError::InvalidSettings` with the reason and nothing is saved. On load, bad rules are dropped and logged, never an error; destination validation is `CommandError::Invalid`; file write failures are typed command errors and leave in-memory state unchanged; a delivery failure is `DeliveryOutcome::Failed { reason, detail }` recorded per destination, emitted to windows and logged without the URL or token; an unreadable destinations file is renamed aside and reported once as `load_error`. No failure returns an empty or default value in place of an error.

## Contracts (scaffold commit)

Rust, phase 1 (signatures are exact; bodies are `unimplemented!`-free stubs that compile and fail tests):

    crates/statglass-schema/src/alert.rs
      AlertRule::validate_custom(&self) -> Result<(), AlertRuleError>
      pub enum AlertRuleError { Name, Metric(String), Labels, Value { min: f32, max: f32 }, Duration, Cooldown, ReservedId, NotThreshold, TooMany, DuplicateId }   // thiserror, Clone, PartialEq (not Eq)
      AlertRule::BUILTIN_IDS: [Uuid; 2]; AlertRule::MAX_CUSTOM: usize = 32; MAX_FOR_SECS = 3600; MIN_COOLDOWN_SECS = 60; MAX_COOLDOWN_SECS = 86_400; MAX_NAME_CHARS = 60
    crates/statglass-schema/src/alert_metrics.rs
      pub struct AlertMetric { metric: &'static str, label: &'static str, default_op: Cmp, default_value: f32, default_for_secs: u32, min: f32, max: f32, default_label: Option<(&'static str, &'static str)> }   // Serialize + specta::Type; default_label is Some(("vol", "/")) for disk.free only, so a new disk rule watches the boot volume, not a mounted installer image
      pub fn series_name(metric: &str, labels: &Labels) -> Option<String>   // None for no labels; fan.rpm with a numeric `fan` value n gives "Fan {n+1}"; otherwise the single label's value
      pub const ALERT_METRICS: &[AlertMetric]   // full data written in the scaffold, see table below
      pub fn alert_metric(metric: &str) -> Option<&'static AlertMetric>
    crates/statglass-schema/src/settings/alerts.rs      AlertSettings moves here from settings.rs (which is at its 650-line ceiling) and is re-exported unchanged
      AlertSettings { hot_process: bool, thermal_serious: bool, #[serde(default)] host_offline: bool, #[serde(default, deserialize_with = "known_rules")] rules: Vec<AlertRule> }   // Clone + PartialEq; no longer Copy or Eq
      known_rules: decodes each list entry on its own and skips one that does not decode (a condition from a newer build), as `deserialize_known_modules` does for modules
      AlertSettings::builtin_rules(&self) -> [AlertRule; 2]      // was rules()
      AlertSettings::engine_rules(&self) -> Vec<AlertRule>       // built-ins then custom, each with its enabled flag
      AlertSettings::validate(&self) -> Result<(), AlertRuleError>   // patch path
      AlertSettings::drop_invalid(&mut self) -> Vec<(Uuid, AlertRuleError)>   // load path: removes rules that fail validate_custom, later duplicates of an id, and anything past MAX_CUSTOM
      Settings::validate does not look at alert rules; SettingsError is unchanged
    crates/statglass-schema/src/event.rs
      AlertCause::Threshold { metric: MetricId, labels: Labels, value: f32, op: Cmp, threshold: f32, for_secs: u32 }   // for_secs is the rule's, so the text does not depend on reading spacing
    crates/statglass-engine/src/detect/threshold.rs
      pub(super) struct ThresholdState; new(series: SeriesSelector, op: Cmp, value: f32, for_ms: i64); bind(&mut self, &[SeriesKey]); on_reading(&mut self, ts_ms, values, periods) -> Option<Held>; mark_reported(); reset() -> bool (was inside a reported episode)
      pub(super) struct Held { since: i64, key_index: usize, value: f32 }
    crates/statglass-engine/src/detect/mod.rs
      Detectors::new(th, &AlertSettings); Detectors::set_alerts(&mut self, &AlertSettings)
      pub fn alert_history_ms(alerts: &AlertSettings) -> i64
    crates/statglass-notify/                      new crate, depends on statglass-schema only
      src/lib.rs        module list and re-exports; no logic
      src/units.rs      pub fn format_value(metric: &str, value: f32, units: &UnitSettings) -> String
      src/text.rs       pub struct AlertText { title: String, body: String }
                        pub fn rule_summary(rule: &AlertRule, units: &UnitSettings) -> String
                        pub fn alert_text(event: &Event, units: &UnitSettings) -> Option<AlertText>
                        pub fn alerts_on_text(rules: &[AlertRule], units: &UnitSettings) -> Option<AlertText>
    src-tauri/src/settings/alerts.rs
      pub struct AlertsPatch { hot_process: Option<bool>, thermal_serious: Option<bool>, host_offline: Option<bool>, rules: Option<Vec<AlertRule>> }; AlertsPatch::apply(self, &mut AlertSettings)
      pub fn alerts_switched_on(old: &Settings, new: &Settings) -> Vec<AlertRule>   // any rule, built-in or custom, enabled now and not enabled (or absent) before
    src-tauri/src/notify.rs
      alerts_on(app, rules: &[AlertRule], units: &UnitSettings); alert(app, event: &Event, units: &UnitSettings)   // thin: text from statglass-notify, post through the plugin
    src-tauri/src/facts.rs       registers the constant ALERT_METRICS

The scaffold also makes every ripple of these type changes compile, and owns those files for phase 1 (no lane edits them): `EngineSettings` loses `Eq` and clones `alerts` (crates/statglass-engine/src/engine.rs, engine/lifecycle.rs); `alert_history_ms(&settings.alerts)` and the `notify::alert`/`notify::alerts_on` call sites with `&UnitSettings` in src-tauri/src/state.rs (the one inside `committed` reads `new.units` from its argument, never the owner); `SettingsOwner::load_with_defaults` calls `drop_invalid` and logs each dropped rule; the patch path calls `AlertSettings::validate` and maps the error to `CommandError::InvalidSettings`; `AlertSettings` literals in detect/tests.rs, state.rs and settings.rs tests; the new crate in the workspace `Cargo.toml`, `src-tauri/Cargo.toml` and `scripts/architecture/crate-edges.json` (`statglass-notify` depends on schema; `statglass` depends on it); `alerts` added to `SCENARIOS` in src/core/mock/fixtures.ts; `src/core/generated/bindings.ts` regenerated.

`ALERT_METRICS` (metric, label, default op, default value, default for_secs, min, max), values in the catalog unit:

    cpu.total       CPU usage          gt  90        300   1     100
    gpu.util        GPU usage          gt  90        300   1     100
    mem.pressure    Memory pressure    gt  80        120   1     100
    mem.swap_used   Swap used          gt  4e9       300   1e8   1e12
    mem.swap_out    Swapping out       gt  1000      120   1     1e6      (pages per second; shown as "1,000 pages/s"; the direct sign of memory thrashing, added at the user's request)
    thermal.hottest Hottest sensor     gt  95        120   30    130
    fan.rpm         Fan speed          gt  4000      120   500   20000
    power.system    System power       gt  60        300   1     1000
    battery.charge  Battery charge     lt  20        0     1     100
    disk.free       Free disk space    lt  20e9      0     1e8   1e14

TypeScript, phase 1:

    src/core/alerts.ts            pure, no React
      ruleSummary(rule: AlertRule, units: UnitSettings): string          // "Memory pressure above 80% for 2 min"
      alertCauseLabel(cause: AlertCause, units: UnitSettings): string    // "Memory pressure 84%"
      availableMetrics(seriesKeys: readonly string[]): AlertMetric[]     // ALERT_METRICS whose metric has a live series
      seriesChoices(metric: string, seriesKeys: readonly string[]): { label: string; labels: Record<string,string> }[]   // "Any" first
      newRule(metric: AlertMetric, id: string): AlertRule                // defaults incl. default_label, enabled, cooldown 1800
      seriesName(metric: string, labels: Record<string,string>): string | null   // same rule as Rust's series_name
      thresholdToDisplay(metric: string, value: number, units): { value: number; unit: string }
      thresholdFromDisplay(metric: string, shown: number, units): number
      lastFiredByRule(events: readonly Event[]): Map<string, number>
      FOR_CHOICES_SECS, COOLDOWN_CHOICES_SECS
    src/core/events.ts            eventLabel handles the threshold cause through alertCauseLabel
    src/core/mock/settings.ts     applyPatch merges alerts.{hot_process,thermal_serious,host_offline,rules}; rejects what Rust rejects (name, range, duration, cooldown, more than 32, duplicate id) with invalid_settings
    src/core/mock/events.ts       the `alerts` scenario seeds one threshold alert and one process alert in the last day

Layout: no new shared component, no `utils` file. Each new module above has the single responsibility on its line.

## Phases

### Phase 1: custom threshold rules, end to end below the UI (MVP)

Demo: `cargo test -p statglass-engine threshold` shows a rule firing once, holding through a cooldown and clearing; `cargo test -p statglass-notify` prints the notification wording; `bun run test -- src/core/alerts.test.ts src/core/mock-transport.test.ts` shows a rule saved through the mock and rejected when invalid.

Test cases:
- validate_custom: accepts every `ALERT_METRICS` default rule; rejects an empty or whitespace name, a name over 60 chars, a metric outside the list, a label key the metric does not carry, more than one label pair, NaN and infinite values, a value below min or above max, `for_secs` 3601, cooldown 59 and 86 401, a built-in id, a non-threshold condition.
- AlertSettings::validate: 33 rules is TooMany; two rules with one id is DuplicateId; a settings file without `rules` or `host_offline` decodes with both built-in switches preserved; `engine_rules` lists built-ins first.
- Load path: a settings file holding one valid rule, one out-of-range rule and one entry with an unknown condition loads with every other setting intact and only the valid rule; `drop_invalid` reports the out-of-range one; a duplicate id keeps the first; `SettingsOwner::load_with_defaults` does not fall back to defaults for a bad rule.
- Threshold evaluation: fires once when the condition has held `for_secs`; `for_secs` 0 fires on the first satisfying reading; a failing reading before the hold completes restarts the hold; NaN (not sampled this tick) neither holds nor clears; a series silent for more than three periods is cleared, where the period is in ms and is the larger of the series' current period and its period at the last reading (as `PowerSpike` does), so a hold in progress survives a window opening and the cadence dropping from 10 s to 1 s; does not fire again while the condition stays met past the cooldown; fires again after clearing and holding again once cooled; a hold that completes inside the cooldown is spent; `lt` rules; a selector matching several series fires for the first to hold and names it; a selector matching nothing never fires; reset (sleep) forgets progress and an episode already reported and still met within the cooldown is not reported again; a disabled rule sees no input.
- Detectors::set_alerts: an unchanged rule keeps its progress; a changed definition restarts progress and keeps its cooldown; a removed rule stops firing; a new rule is bound to the current layout at once; `seed_alert_history` holds a custom rule off after a restart; `alert_history_ms` is the longest cooldown among all rules.
- Allocation gate: the detectors case with two custom rules on still allocates nothing per quiet tick.
- Text: `rule_summary` for each comparison and for `for_secs` 0 ("Battery charge below 20%"), 30 ("for 30 s"), 120 ("for 2 min"); a labelled rule names its series through `series_name` ("Fan speed (Fan 1) above 4,000 rpm", "Free disk space (/) below 20 GB"); bytes follow the memory unit for `mem.*` and are decimal GB for `disk.*`; temperatures follow the temperature unit; `alert_text` for a threshold cause gives title = rule name and body = "<label> <value> · <comparison> <threshold> for <duration>" with " for <duration>" left out when the cause's `for_secs` is 0; process and thermal texts are unchanged from today; `alerts_on_text` lists custom rules by summary; non-alert events give None.
- Patch: `rules` replaces the list; an invalid rule fails the update with `invalid_settings` and saves nothing; switching a custom rule on, or adding an enabled one, is in `alerts_switched_on`; editing a rule that stays enabled is not; a rules change is engine-affecting.
- Core: `ruleSummary` matches the Rust wording for the same cases; `thresholdToDisplay`/`thresholdFromDisplay` round-trip °F, GiB and GB; `availableMetrics` drops metrics with no live series; `seriesChoices` gives "Any" then one entry per series, named by `seriesName`; `newRule` for disk.free selects `vol=/`; `lastFiredByRule` keeps the newest alert per rule id; `eventLabel` for a threshold alert.
- Mock: an `update_settings` rules patch is stored and emitted; each invalid case is rejected; the `alerts` scenario's events are returned by an events query.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-engine/src/detect/threshold.rs, crates/statglass-engine/src/detect/alerts.rs, crates/statglass-engine/src/detect/mod.rs, crates/statglass-engine/tests/perf_gates.rs | contracts, crates/statglass-engine/src/detect/detectors.rs | crates/statglass-engine/src/detect/threshold_tests.rs | opus | pending | | threshold tests and the existing detect tests pass |
| b | M | crates/statglass-schema/src/alert.rs, crates/statglass-schema/src/settings/alerts.rs, src-tauri/src/settings/alerts.rs | contracts, src-tauri/src/settings/overview.rs | crates/statglass-schema/src/alert_validation_tests.rs, crates/statglass-schema/src/settings/alerts_tests.rs, src-tauri/src/settings/alerts_tests.rs | opus | pending | | validation and patch tests pass |
| c | M | crates/statglass-notify/src/text.rs, crates/statglass-notify/src/units.rs, src-tauri/src/notify.rs | contracts, src/core/format/units.ts | crates/statglass-notify/tests/text.rs | opus | pending | | text tests pass |
| d | M | src/core/alerts.ts, src/core/events.ts, src/core/mock/settings.ts, src/core/mock/events.ts | contracts, src/core/format/units.ts | src/core/alerts.test.ts, src/core/mock-alerts.test.ts | opus | pending | | core and mock tests pass |

#### Lane a brief

- Goal: evaluate custom threshold rules in the engine next to the built-in rules, and let the rule set change at runtime without losing cooldowns.
- Interface: implement `ThresholdState` in `detect/threshold.rs` and use it from `AlertEval` in `detect/alerts.rs` in place of `State::Unsupported`; implement `Detectors::set_alerts(&AlertSettings)` and `alert_history_ms(&AlertSettings)` in `detect/mod.rs` as stubbed. `TickInput::periods` is each series' sampling period in the unit the existing detectors already use (see `PowerSpike`'s gap handling in `detectors.rs`).
- Behavior: every line under "Threshold evaluation", "Detectors::set_alerts" and "Allocation gate" in the test cases. Fired events carry `AlertCause::Threshold { metric, labels, value, op, threshold, for_secs }` (`for_secs` is the rule's) for the series that held, `start_ms` = when that series started holding, empty `processes`. The resumed-episode rule is the thermal rule's: after a reset inside a reported episode, the condition still met within the cooldown is the episode already reported. `set_alerts` matches evaluators by rule id: equal rule keeps its evaluator, a different definition under the same id gets a new evaluator carrying the old `last_fired`, an absent id is dropped; built-in evaluators always exist, on or off. In `perf_gates.rs`, the detectors case binds only fan, thermal and power keys with a 5-slot values array: add `mem.pressure` to its keys and values, add two enabled custom rules (`mem.pressure` gt 1 for 0 s with a 3600 s cooldown, which fires inside the warm-up ticks and then holds state, and `fan.rpm` gt 100000, which never holds), and keep the post-warm-up `out.is_empty()` assertion and the ceiling of 0.
- Decisions already made: no aggregation; "any matching series" semantics; a gap clears; nothing allocates on a tick that fires nothing (bind may allocate).
- Out of scope: host-offline rules, remote hosts, hysteresis, any change to the built-in rules' behavior, new public API beyond the contracts.
- Done when: `cargo test -p statglass-engine --lib detect` passes, `cargo test -p statglass-engine --test perf_gates detectors -- --nocapture` reports 0 for detectors, `cargo check --workspace --all-targets` is clean.

#### Lane b brief

- Goal: validate custom rules in the schema and carry them through the settings patch.
- Interface: `AlertRule::validate_custom` and `series_name` in `alert.rs`/`alert_metrics.rs` as stubbed (`alert_metrics.rs` data is scaffold-owned; `series_name` lives in `alert.rs`); `AlertSettings::validate`, `drop_invalid`, `engine_rules`, `builtin_rules` and the `known_rules` deserializer in `settings/alerts.rs`; `AlertsPatch::apply` and `alerts_switched_on` in `src-tauri/src/settings/alerts.rs`. The scaffold has already wired the patch path, the load path and the call sites in `src-tauri/src/settings.rs` and `state.rs`; do not edit those.
- Behavior: every line under "validate_custom", "AlertSettings::validate", "Load path" and "Patch" in the test cases. Name length counts chars after trimming. A label key is valid when the catalog metric lists it in `label_keys`. Each `AlertRuleError` message states the limit ("cooldown must be between 1 minute and 24 hours").
- Decisions already made: the list is replaced whole by a patch; no migration; ids come from the client and must not be built-in ids.
- Out of scope: destinations, host-offline behavior beyond the stored flag, renaming existing settings fields.
- Done when: `cargo test -p statglass-schema alert` and `cargo test -p statglass alerts` pass, `make architecture-check` passes (file ceilings), `cargo check --workspace --all-targets` is clean.

#### Lane c brief

- Goal: one place for what a rule and an alert say, used by macOS notifications now and destinations later.
- Interface: `format_value`, `rule_summary`, `alert_text`, `alerts_on_text` in `statglass-notify` as stubbed; `src-tauri/src/notify.rs` keeps `alerts_on` and `alert` as thin wrappers that take `&UnitSettings`, get text from the crate and post through `tauri-plugin-notification`, with its own text functions and their tests removed (the scaffold moves the still-valid assertions into `crates/statglass-notify/tests/text.rs`).
- Behavior: every line under "Text" in the test cases. `format_value` picks the unit from the catalog metric: percent as a whole number with "%", watts with one decimal under 10 and none above, rpm and pages per second with thousands separators ("4,000 rpm", "1,000 pages/s"), Celsius converted when the setting is Fahrenheit and shown as whole degrees with the unit, bytes as GB or GiB with one decimal and a trailing ".0" dropped ("20 GB", "3.7 GiB"; binary only for `mem.*` when the memory unit is binary). Durations: under 120 s in seconds, otherwise whole minutes. Comparisons read "above" for gt and ge, "below" for lt and le. A metric missing from `ALERT_METRICS` falls back to its catalog id as the label.
- Decisions already made: wording is Rust-owned for notifications; the client has its own formatter for the page and the two must agree on the cases in the tests.
- Out of scope: delivery, curl, destinations, localization.
- Done when: `cargo test -p statglass-notify` and `cargo test -p statglass notify` pass, `cargo check --workspace --all-targets` is clean.

#### Lane d brief

- Goal: the pure TypeScript the Alerts page needs, and a mock transport that stores and rejects rules as Rust does.
- Interface: everything listed under "TypeScript, phase 1" in the contracts. Use the existing formatters in `src/core/format` for values; `ALERT_METRICS`, `METRIC_UNITS` come from `@core/generated/bindings`.
- Behavior: every line under "Core" and "Mock" in the test cases. `thresholdToDisplay` returns GB or GiB for byte metrics (GiB only for `mem.*` with the binary setting), °F when set, the catalog unit otherwise. `seriesChoices` labels a series by its single label value. `FOR_CHOICES_SECS` is 0, 30, 60, 120, 300, 600, 1800; `COOLDOWN_CHOICES_SECS` is 60, 300, 900, 1800, 3600, 21600, 86400.
- Decisions already made: Rust owns validation; the mock mirrors it so page tests see realistic rejections; the client never invents a metric list.
- Out of scope: React components, transport contract changes, destinations.
- Done when: `bun run test -- src/core/alerts.test.ts src/core/mock-alerts.test.ts src/core/events.test.ts` passes and `bun run typecheck` is clean.

### Phase 2: the Alerts page

Demo: `bun run dev:fast`, open `/?route=/dashboard/alerts&scenario=alerts`: create a rule from a template, edit it, switch it off, delete it; Recent lists the scenario's alerts.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/app/routes/dashboard/alerts/_components/rules-panel.tsx, src/app/routes/dashboard/alerts/_components/rule-row.tsx, src/app/routes/dashboard/alerts/_components/rule-dialog.tsx, src/app/routes/dashboard/alerts/_lib/rule-form.ts | contracts, src/app/routes/dashboard/hosts/_components/host-settings-dialog.tsx | src/app/routes/dashboard/alerts/_components/rules-panel.test.tsx, src/app/routes/dashboard/alerts/_components/rule-dialog.test.tsx, src/app/routes/dashboard/alerts/_lib/rule-form.test.ts | opus | pending | | rules panel, dialog and form tests pass |
| b | M | src/app/routes/dashboard/alerts/_components/recent-alerts.tsx, tests/e2e/alerts.spec.ts | contracts, src/app/routes/dashboard/timeline/route.tsx | src/app/routes/dashboard/alerts/_components/recent-alerts.test.tsx | opus | pending | | recent tests pass; the e2e spec is written |

Phase 2 scaffold (wiring, owned by no lane): `alerts/route.tsx` (PageHeader "Alerts" with a "New rule" button, the `editing` draft state, `<RulesPanel>`, `<RecentAlerts>`, `<RuleDialog>`), the router entry, the sidebar entry and its `alerts` icon between Containers and Settings and its removal from the remote-host tool list, the Settings route without `AlertsPanel` (file deleted), `alerts/_hooks/use-recent-alerts.ts` (alert events of the last 7 days for This Mac through `useEventsQuery`, newest first) and `alerts/_hooks/use-series-keys.ts` (the local host's live layout keys, a stable reference until the layout changes), component stubs, and the tests named below.

Contracts:

    alerts/_lib/rule-form.ts     pure form state for one rule
      interface RuleForm { id, name, autoName: boolean, metric, labels: Record<string,string>, op: "gt" | "lt", shown: string, forSecs, cooldownSecs, enabled }
      formFromRule(rule, units): RuleForm; formForMetric(metric: AlertMetric, id, units): RuleForm
      withMetric(form, metric, units): RuleForm     // new defaults, keeps a typed name
      ruleFromForm(form, units): AlertRule          // converts the shown threshold to the stored unit
      formProblem(form, units): string | null       // "Enter a number", "Between 1 and 100%", "Give the rule a name"; null when it can be saved
    alerts/_components/rule-dialog.tsx    RuleDialog({ draft: { rule: AlertRule; isNew: boolean } | null, onClose })
    alerts/_components/rules-panel.tsx    RulesPanel({ onEdit: (rule: AlertRule) => void })
    alerts/_components/rule-row.tsx       one rule's row: label, sub line, switch, edit button
    alerts/_components/recent-alerts.tsx  RecentAlerts()

Test cases:
- Route: the sidebar lists Alerts between Containers and Settings on This Mac and not while a remote host is selected; Settings has no Alerts panel; the page shows Rules and Recent; "New rule" opens the dialog on the first available metric.
- Rules panel: the two built-in rows come first with their current labels and write `{ alerts: { hot_process } }` / `{ alerts: { thermal_serious } }`; a custom row's label is the rule name; its sub line is the summary when the name differs from it, then "Last fired 2 h ago" as a Timeline link or "Never fired"; a rule whose metric has no live series reads "Not measured on this Mac"; the switch writes the whole rules list with that rule's `enabled` flipped; Edit calls `onEdit` with the rule; the panel does not re-render on a live tick (render-count test).
- Rule dialog: the metric select lists only available metrics; choosing one fills comparison, threshold, duration and the name; a typed name survives a metric change; a labelled metric shows a series select with "Any" then series names, and Free disk space starts on "/"; the threshold is shown and stored through the display-unit conversion (°F, GiB); `formProblem` text shows inline and Save is disabled; Save sends one patch with the rule appended (new) or replaced (edit) and closes; an `invalid_settings` or `settings_not_saved` answer shows its message inline and keeps the dialog open with the form intact; Delete is shown only for an existing rule, removes it and closes; Cancel and Escape write nothing; the "Now" line shows the watched series' current value and is the only part that renders on a tick.
- rule-form: round trip `formFromRule`/`ruleFromForm` for each metric kind; `withMetric` keeps a custom name and replaces an auto name; `formProblem` cases.
- Recent: newest first, at most 20; each line is the time on the host clock, `eventLabel`, and a Timeline link; "No alerts in the last 7 days." when empty or while history is unavailable.
- E2E (`alerts.spec.ts`, light and dark, scenario `alerts`): create a Memory pressure rule, see its row; edit the threshold and see the sentence change; switch it off; delete it; Recent lists the two seeded alerts; one full-page screenshot per theme at `test-results/screens/alerts-<theme>-<project>.png`.

#### Lane a brief

- Goal: the Rules panel and the rule editor on the Alerts page.
- Interface: implement `rule-form.ts`, `RuleDialog`, `RulesPanel` and the row component as stubbed. Read settings with `useSettings`, write with the transport's `updateSettings` so the dialog sees the command result, take units from settings, series keys from `use-series-keys`, last-fired times from `use-recent-alerts` through `lastFiredByRule`, wording from `@core/alerts`. Build the panel from `SettingsPanel`/`SettingsRow`, the dialog from `~/components/ui/dialog`, `select`, `SegmentedControl` and `Button`, the way `hosts/_components/host-settings-dialog.tsx` does.
- Behavior: every line under "Rules panel", "Rule dialog" and "rule-form" in the phase 2 test cases. Duration choices and cooldown choices come from `FOR_CHOICES_SECS` and `COOLDOWN_CHOICES_SECS`, labelled "Right away", "30 s", "1 min" and so on. The comparison control offers "above" and "below" (stored as gt and lt). New ids come from `crypto.randomUUID()`. The Timeline link is a 1 h window centered on the alert, built the way other pages link to a range (`@core/range-params`). Type roles, radii and colors come from the theme tokens only; no new shared component, no card grid, no badge, no eyebrow label. Load the `frontend-design-slop` skill before writing JSX and compare with the Settings and Hosts pages.
- Decisions already made: built-in rules are switches only; no delete confirmation; one settings patch per change; Rust validation is the authority and its message is shown as is.
- Out of scope: destinations, the Recent list, host-offline row, changing shared components, the route file.
- Done when: `bun run test -- src/app/routes/dashboard/alerts` passes for the rules panel, dialog and rule-form tests, `bun run typecheck` and `bun run lint` are clean.

#### Lane b brief

- Goal: the Recent list, and the end-to-end spec for the whole page.
- Interface: implement `RecentAlerts` as stubbed, reading `use-recent-alerts`; write `tests/e2e/alerts.spec.ts` in the style of `tests/e2e/remote-hosts.spec.ts`.
- Behavior: every line under "Recent" and "E2E" in the phase 2 test cases. The spec drives the UI by accessible names from lane a's brief: the "New rule" button, a dialog titled "New rule" or "Edit rule", fields labelled "Metric", "Watch", "When it is", "Threshold", "For", "Then wait", "Name", buttons "Save", "Cancel", "Delete", and per-row controls "Edit <rule name>" and a switch named by the rule name. Lane a builds those in parallel, so run the spec's Recent assertions against your own work and report that the rest waits for the merge; the orchestrator runs it at the phase gate.
- Decisions already made: Recent is a plain list in a `SettingsPanel`, no table, no chart.
- Out of scope: the rules panel, the dialog, destinations.
- Done when: `bun run test -- src/app/routes/dashboard/alerts/_components/recent-alerts.test.tsx` passes, the spec file typechecks and lints.

### Phase 3: destinations and delivery

Demo: `cargo test -p statglass-notify deliver` posts an ntfy and a webhook message to a local listener through real curl; in `bun run dev` a saved ntfy destination receives "Send test".
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-notify/src/request.rs, crates/statglass-notify/src/curl.rs, crates/statglass-notify/src/deliver.rs, crates/statglass-schema/src/alert_destination.rs | contracts, src-tauri/src/addresses.rs | crates/statglass-notify/tests/deliver.rs, crates/statglass-schema/src/alert_destination_tests.rs | opus | pending | | delivery and validation tests pass |
| b | M | src-tauri/src/alerts/ | contracts, src-tauri/src/star_prompt.rs | src-tauri/src/alerts_tests.rs | opus | pending | | store, command and dispatch tests pass |
| c | S | src/core/alert-destinations.ts, src/core/mock/alert-destinations.ts | contracts, src/core/mock/shell.ts | src/core/alert-destinations.test.ts | opus | pending | | core and mock tests pass |

Phase 3 scaffold (owned by no lane): the schema types below with `validate` stubbed, the `statglass-notify` module stubs, `src-tauri/src/alerts/` module stubs, the four commands and the `alert-destinations-changed` event registered in `src-tauri/src/lib.rs`, `AppState.alerts` and the call from the host watcher's `BusMsg::Event` arm for local alert events in `src-tauri/src/state.rs` (kept inside its 600-line ceiling by putting logic in `alerts/`), regenerated bindings, the transport contract and native wiring (`getAlertDestinations`, `saveAlertDestination`, `deleteAlertDestination`, `testAlertDestination`, `onAlertDestinationsChanged`), the mock contract and its registration, and the tests named in the table.

Contracts:

    crates/statglass-schema/src/alert_destination.rs    destination data and its validation
      pub struct Destination { id: Uuid, name: String, enabled: bool, kind: DestinationKind }
      pub enum DestinationKind { Ntfy { server: String, topic: String, token: Option<String> }, Webhook { url: String } }   // tag = "type", snake_case
      Destination::validate(&self) -> Result<(), DestinationError>; pub enum DestinationError { Name, Url, Topic, Token }
      pub const MAX_DESTINATIONS: usize = 8
      pub enum DeliveryOutcome { Delivered { status: u16 }, Failed { reason: DeliveryFailure, detail: String } }
      pub enum DeliveryFailure { CurlMissing, NameNotFound, ConnectFailed, TimedOut, Tls, Http, Rejected, Other }
      pub struct DeliveryRecord { at_ms: i64, outcome: DeliveryOutcome }
    crates/statglass-notify/src/request.rs    turns a message and a destination into one HTTP request; pure
      pub struct Message { title: String, body: String, host: String, rule: Option<String>, kind: String, fired_at_ms: i64 }
      pub struct HttpRequest { url: String, headers: Vec<(String, String)>, body: String }
      pub fn build_request(destination: &Destination, message: &Message) -> HttpRequest
    crates/statglass-notify/src/curl.rs       runs one request through curl and classifies the result; the only module that spawns a process
      pub fn config_text(request: &HttpRequest) -> Result<String, String>     // Err names the field holding a control character
      pub fn arguments(timeout_secs: u32) -> Vec<String>
      pub fn run(curl: &Path, request: &HttpRequest, timeout_secs: u32) -> DeliveryOutcome
    crates/statglass-notify/src/deliver.rs    the retry policy
      pub struct DeliverOptions { curl: PathBuf, timeout_secs: u32, backoff: [Duration; 2] }   // Default: /usr/bin/curl, 10, [2 s, 10 s]
      pub fn deliver(destination: &Destination, message: &Message, options: &DeliverOptions) -> DeliveryOutcome
    src-tauri/src/alerts/
      mod.rs        AlertsService: the destination list, last delivery per destination, and the entry points the shell calls; no file or process I/O of its own
      store.rs      reads and writes alert-destinations.json (atomic, 0600); the only module that touches the file
      dispatch.rs   turns an alert event into a Message and sends it to each enabled destination off the calling thread
      commands.rs   the four Tauri commands; thin
      pub struct AlertDestinationsView { destinations: Vec<DestinationView>, load_error: Option<String> }
      pub struct DestinationView { destination: Destination, last: Option<DeliveryRecord> }
      AlertsService::open(dir: &Path) -> Self; view(); save(Destination) -> Result<AlertDestinationsView, CommandError>; delete(Uuid) -> Result<..>; on_alert(event: &Event, host_name: &str, units: &UnitSettings, send: impl Fn(Destination, Message) + ...)
    src/core/alert-destinations.ts
      destinationAddress(d: Destination): string            // "ntfy.sh/statglass-4f2a…" or the webhook's host
      deliveryLabel(record: DeliveryRecord | null, timeOf: (ms: number) => string): string | null   // "Delivered 14:02", "Failed 14:02 · HTTP 403"
      generateTopic(random: (n: number) => Uint8Array): string   // "statglass-" + 20 base32 chars
      newDestination(kind: "ntfy" | "webhook", id: string): Destination

Test cases:
- Validation: a name of 1 to 40 chars after trimming; ntfy server and webhook URL must start with `http://` or `https://`, have a host, be at most 2,048 chars and hold no whitespace, control character, quote or backslash; a topic is 1 to 64 of `[A-Za-z0-9_-]`; a token is at most 256 chars with no whitespace or control character, and an empty token is None.
- Request: ntfy posts to the server root with JSON `topic`, `title`, `message`, `priority` 4 and `tags` ["warning"], `Content-Type: application/json`, and `Authorization: Bearer <token>` only when a token is set; a trailing slash on the server is not doubled; the webhook body has `text` and `content` ("title: message"), `title`, `message`, `host`, `rule`, `kind`, `fired_at_ms`.
- Curl config: quotes, backslashes, newlines, carriage returns and tabs in a title or process name arrive byte-exact in the body at a local listener; a body containing a line `output = "/tmp/statglass-pwn"` creates no file; another control character in any field is `Failed { reason: Rejected }` without spawning; `arguments` starts with `-q`, includes `--proto`, `=http,https`, `--max-redirs`, `0`, `-K`, `-`, and never holds the URL, a header or the body.
- Outcomes against a local listener through real curl: 200 and 204 are Delivered; 403 is Failed Http "HTTP 403" after one request; 500 then 200 is Delivered after two; 500 three times is Failed Http "HTTP 500" after three; 302 is Failed Http "HTTP 302" and the redirect target sees nothing; a refused port is ConnectFailed; a `.invalid` host is NameNotFound; a listener that never answers with `timeout_secs` 1 is TimedOut; a curl path that does not exist is CurlMissing; `file:///etc/hosts` as a URL never reads the file.
- Store: a missing file is an empty list with no error; save then open round-trips; the file mode is 0600; a malformed file is renamed to `alert-destinations.json.bad` and `load_error` says so; a save that cannot write returns `CommandError` and leaves the in-memory list unchanged; saving an existing id replaces it; a ninth destination is rejected; an invalid destination is rejected with its reason; deleting an unknown id is `InvalidArgument`.
- Dispatch: an alert goes to every enabled destination and to no disabled one; each outcome is recorded with its time and emitted once; a non-alert event sends nothing; the test command sends "Test from StatGlass on <host>" to the given destination without saving it and returns the outcome; the newest record wins when two deliveries finish out of order.
- Core and mock: `deliveryLabel` for delivered, each failure detail and null; `destinationAddress`; `generateTopic` shape; the mock stores, replaces, deletes, rejects a ninth, emits changes, and its test delivery fails when the `alert-delivery-fails` scenario is on.

(Briefs follow the lane table rows and the contracts above; written in full before dispatch.)

### Phase 4: destinations on the page, and host offline

Demo: in `bun run dev:fast` add an ntfy destination, press Send test, see "Delivered"; with the `mac-offline` scenario and the host rule on, an offline alert appears in Recent.
Depends on: phase 2, phase 3

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/app/routes/dashboard/alerts/_components/destinations-panel.tsx, src/app/routes/dashboard/alerts/_components/destination-row.tsx, src/app/routes/dashboard/alerts/_components/destination-dialog.tsx, tests/e2e/alert-destinations.spec.ts | | | opus | pending | | |
| b | M | src-tauri/src/alerts/host_offline.rs, src-tauri/src/alerts/host_watch.rs | | | opus | pending | | |

(Test cases and briefs written during phases 2 and 3.)

## Log
- Scaffold 71fb6f5c (opus builder), deviations accepted: `AlertEval` already routes thresholds through `ThresholdState` (a stub that lane a replaces); `recent_alerts` moved to `History::recent_alerts` to keep state.rs under its ceiling; `eventLabel(e)` keeps one argument and uses display defaults, `alertCauseLabel` takes `UnitSettings | null`; `mockEvents` takes the alerts scenario flag (lane d seeds through it, store.ts is scaffold-owned); `series_name` lives in `alert.rs`; f32 range limits reach TypeScript rounded (1e12 is 999999995904), so the mock compares as f32 with `Math.fround`. Open for the docs pass: `.claude/rules/rust/crates.md` edge list lacks `statglass-notify`.
- User request during phase 1: alert on swap. `mem.swap_used` was already in `ALERT_METRICS`; `mem.swap_out` (pages per second) is added as the thrashing signal, with a pages/s formatter on both sides.
- Plan critique (devils-advocate, opus), eight findings, all checked and accepted: (1) one invalid stored rule would have reset every setting through `load_with_defaults`, so validation runs on the patch path only, the load path drops bad rules and the rules list decodes leniently; (2) the type changes ripple into engine.rs, lifecycle.rs, state.rs, test literals, Cargo and crate-edges, now listed as scaffold-owned, and `SettingsError` stays untouched; (3) the gap rule uses the larger of the current and last-reading period, with a cadence-change test; (4) `disk.free` with "Any" fired on a mounted DMG, so new disk rules default to `vol=/` through `AlertMetric.default_label`; (5) fan labels are "0"/"1", so both sides name series through one `series_name` rule, and `for_secs` moved into `AlertCause::Threshold`; (6) the curl request spec (no `--fail`, `%{http_code}`, exit-code mapping, quoted and escaped config values, control-character rejection) is in RFC 6.4 and becomes phase 3 test cases; (7) the perf-gate case gets `mem.pressure` in its layout so the custom rule holds state; (8) new `AlertCause` variants and rules in Settings are safe (events are opaque CBOR, settings never leave the Mac), and `AlertSettings` moves to `settings/alerts.rs` to respect the schema file ceiling.
