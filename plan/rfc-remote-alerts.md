# RFC: Alert rules on remote hosts

Status: Draft, revision 3, 2026-11-24. Revision 2 folds in a ce:devils-advocate review
against the code (section 9); revision 3 drops the Hello feature flag. Decision entry: D-152, written when this is accepted.
Builds on [rfc-alerts.md](rfc-alerts.md) (D-138) and takes the threshold-rule part of phase
4.2c of [v4](v4-remote-hosts.md).

## 1. Problem

Alert rules only watch This Mac. The machines a user is least likely to be looking at, a
Linux server or a homelab box running the headless agent, can fill a disk or start
swapping without anyone hearing about it. The host-offline rule (D-138) reports that a
host stopped answering, not what happened on it.

## 2. Where evaluation runs

There were two candidates.

Evaluating on this Mac over the summary stream looks free, since every connected host
already pushes a `HostSummary` every 5 s with no window open. It does not hold up. Summary
frames carry the host's `held` display values and publish `values` as NaN
(`statglass-remote/src/source.rs`, the `HostSummary` arm): by the data-boundary rule they
measure nothing, and the threshold evaluator ignores them. Using them would mean alerting
on display holds at 5 s resolution, over the 17 headline series only, and only while this
Mac is awake and connected.

Evaluating on the host is most of the way built. The agent's engine already takes
`Settings.alerts` (`EngineSettings::from_settings`) and runs the same threshold evaluator
on its own persisted tick at full resolution, from `settings.json`. Alert events go into
the agent's history and already sync to this Mac's mirror as `rows.events`. What is
missing is a way to set the rules, cooldowns that survive an agent restart, and this Mac
acting on the events as they arrive.

This RFC evaluates on the host. Rules keep running and recording while this Mac sleeps;
only delivery waits for it.

## 3. Scope

In:

- Custom threshold rules on Linux agent hosts, edited from this Mac's Alerts page with
  the host selected.
- This Mac delivers those hosts' alert events (notification and destinations) as they
  sync in.
- `mem.psi` ("Memory stall") joins `ALERT_METRICS`, because Linux has no `mem.pressure`.
- `cpu.loadavg` ("Load average") joins `ALERT_METRICS`, starting on the 5-minute window.
  It is the metric server alerting conventionally watches. macOS reports it too, so this
  Mac's own page offers it as well.

Out, each for a stated reason:

- Rules on remote Macs. A remote Mac runs the full app with its own Alerts page and its
  own destinations; if this Mac also delivered its events, every alert would arrive twice.
  Its alerts already show on its Timeline here through the mirror.
- The agent delivering by itself, which is what makes an always-on server alert while
  every Mac is asleep. It needs destination secrets on the server and a dedupe rule
  between the agent and this Mac. It is the next step, and nothing here blocks it.
- The built-in rules (hot process, thermal Serious) on agents.
- Rules applied to several hosts at once.

## 4. Product decisions

1. With a Linux host selected, the Alerts page shows that host's rules. The header says
   whose rules they are ("Alerts on m1-linux"). The "Send to" panel stays this Mac's list,
   with a sub line saying alerts are sent from this Mac. Recent lists that host's alerts.
2. The rule dialog offers the `ALERT_METRICS` entries the host actually publishes, read
   from its live layout. On a typical Linux host that is CPU, memory stall, swap used,
   swapping out, hottest sensor, fan, system power, battery and free disk.
3. Saving a rule needs the host connected. While it is not, the rule list stays readable
   from the last answer, with the editing controls disabled and the reason shown
   ("m1-linux is not connected"). An agent too old to accept rules shows "Update the
   agent on m1-linux to set alerts" with the existing update action.
4. A rule change applies on the host at once, with no agent restart and no gap in its
   history.
5. A fresh alert (fired 10 minutes ago or less when it reaches this Mac) is delivered
   like a local one. Older alerts that arrive together, after this Mac slept or the host
   was unreachable, go out as one notification and one message per host: "While this Mac
   was away, m1-linux raised 3 alerts: Free disk space below 20 GB, …". They are on the
   Timeline either way.
6. The page says once, under the rule list, that rules run on the host and that alerts
   reach you when this Mac is awake and connected.

## 5. Architecture

### 5.1 Setting rules: two host queries

`Query::AlertRules` returns the host's custom rules and a revision.
`Query::SetAlertRules { base_revision, rules }` replaces them. Both are additive to the
D-117 query channel. `lenient` turns a whole query or answer into `Unknown` when any part
fails to decode, so rules travel as individually encoded entries and are decoded one at a
time, the way `StoredRule` does in `settings/alerts.rs`: one rule from a newer build is
shown as "Made by a newer version" and kept, not lost with the whole list.

There is no Hello feature flag for this. Which hosts get rules is decided by what the host
is: a Linux host is an agent host (`HostInfo.os`), and that is how the app already picks
its Linux page variants. Remote Macs never get the page. An agent too old to know the
queries answers them as `Query::Unknown`, which is `ErrorCode::Unsupported`
(`host_queries.rs`); the controller maps that to "Update the agent", read once when the
page opens with `Query::AlertRules`. Agents update from this Mac, so that state is short.
A headless agent for macOS, if one is ever built, would need a real host-kind field in
place of the OS check.

`ServedHost` gains `alert_rules()` and `set_alert_rules()`, defaulting to an unsupported
answer, so the query handler in `statglass-remote` never reaches into agent code. The Mac
app keeps the defaults, which is its refusal (section 3). `AgentHost` keeps its data
directory and the current `Settings` in memory. `set_alert_rules`, under one mutex:

1. checks `base_revision` against the current revision, refusing a stale edit (a second
   Mac changed the rules since this dialog loaded them);
2. validates every rule with `AlertRule::validate_custom` and the `AlertSettings` limits;
3. merges `{"alerts":{"rules":[...]}}` into `settings.json` through the `configure` merge
   (atomic write);
4. applies the in-memory `Settings` with only `alerts.rules` replaced, through
   `SourceControl::apply_settings`. It never applies what `configure` read back, which
   would also switch on CLI `configure` changes that were meant to wait for a restart.

Evaluators whose definition did not change keep their progress (`lifecycle.rs` treats an
alerts change as cadence-only). A rejected rule comes back as `Answer::Error` with the
`AlertRuleError` text and nothing is written. Answers run concurrently on `spawn_blocking`,
which is why the mutex covers write-then-apply. The CLI `configure` command still races the
file; it is a maintenance tool and its changes apply on restart, so the window is accepted.

The agent's `settings::load` calls `AlertSettings::drop_invalid`, as the app does, so a
rule that a rolled-back agent no longer validates is dropped with a warning instead of
staying loaded.

The agent is the single owner of its rules. This Mac keeps no copy beyond the last answer
it showed, so a second Mac paired to the same agent sees the same rules.

### 5.2 Cooldowns across agent restarts

At start the agent seeds its detectors from its store through
`LocalSource::seed_alert_history`, before `AgentHost::start`, reading back
`alert_history_ms` the way `src-tauri/src/state.rs` does. The reader (`recent_alerts`)
lives in `src-tauri/src/history.rs` today and moves into the engine so both can call it.
Without this, an agent update resets every cooldown and a still-full disk alerts again
straight away. When history is unavailable at start and reattached later (the retry
loop), the agent seeds on reattach.

The update transaction snapshots `settings.json` and restores it on rollback, which can
revert rule edits made during an update. That is accepted: updates are short and the
controller re-reads rules after reconnecting.

### 5.3 Delivery on this Mac

Alert events from agent hosts reach this Mac in mirrored `SyncPage.events`, every 60 s on
AC and every 300 s when this Mac is on battery (`source.rs`, the sync period). After a page
is ingested durably, the mirror ingest path passes the page's alert events, meaning events
whose `EventDetail` is an alert, to the shell. The shell runs them through the existing
`fire::announce` path (notification, destinations, `event-recorded`). The store write is
already done, because the mirror holds the event.

Duplicates: the mirror already dedupes events by `(host, source_epoch, source_id)` with a
`source_seq` guard (`statglass-store` `writer/sync.rs`). `ingest_page_durable` returns
an `IngestReport` that `mirror.rs` discards, and it carries only counts. It gains the
alert events it actually inserted, and only those are delivered. A replayed page after
`Truncated` or a same-epoch resync inserts nothing and delivers nothing. A timestamp
watermark was rejected: every alert has kind `"alert"`, so it would reduce to `ts_ms`,
and an agent clock stepping back (a homelab box with no RTC, an NTP correction) would drop
new alerts without a trace.

A floor stops back history from firing: inserted events from before this Mac first
delivered for the host (set on the first ingest after pairing or after this Mac gains the
feature) are Timeline-only. The floor is per host in the alert state next to `alert-destinations.json`;
losing it costs at most one catch-up message, never a lost alert.

Staleness is measured on this Mac's clock: an event's `ts_ms` is converted with the
source's offset-corrected host clock (`RemoteSource::clock`) before comparing with now, so
a skewed agent clock cannot make every alert look stale or future-dated. Events more than
10 minutes old by that measure are grouped per host per ingest pass into the single
message from 4.5.

The macOS notification gets the host name for any host other than This Mac.
`notify::alert` posts `alert_text(event)` with no host today (only destinations name the
host), so "Free disk space below 20 GB" would read as this Mac's disk.

Only agent hosts (Linux) are delivered for, so a remote Mac's own alerts never double up.

### 5.4 Latency

Delivery trails the host by up to one sync period, 60 s on AC or 5 min on battery. Rule
durations are minutes long, so that is acceptable for the first version. If it is not,
the fix is to forward `BusMsg::Event` over the live connection as an additive message,
with the synced copy as the catch-up path and the watermark deduping the two. That is
left out until someone asks for it.

### 5.5 Frontend

Three This-Mac gates change, for Linux hosts:
the layout that renders Alerts in the local store (`dashboard/route.tsx`), the sidebar
filter that drops Alerts for remote hosts (`live-sidebar.tsx`), and the store
`useSeriesKeys` and `useRecentAlerts` read from. Remote Macs keep all three. Alerts is not
a `metricPage`, so the shared disconnected and focal states do not apply; the "not
connected" and "update the agent" states are the page's own, built from the same notice
components. The built-in and host-offline switches are hidden for an agent host.

The rules panel reads through transport commands (`remote_alert_rules`,
`set_remote_alert_rules`) instead of `Settings.alerts.rules` when a remote host is
selected. Rule sentences and form state in `src/core/alerts.ts` are shared, and learn the
`stall` label for `mem.psi`. Metric availability comes from the host's layout, which Rust
publishes. The mock transport gets a Linux host with rules, a too-old agent, a
disconnected host and a stale-revision refusal.

### 5.6 Error model

| Failure | Reported as | What the user sees |
|---|---|---|
| Host not connected | `CommandError` from the call (not connected) | Editing disabled, "m1-linux is not connected" |
| Rules changed by another Mac since the dialog loaded | `Answer::Error` (stale revision) | "The rules on m1-linux changed. Reload them and try again." |
| A rule from a newer build | decoded per rule as unknown | Row reads "Made by a newer version"; kept on save |
| Agent too old for the queries | `ErrorCode::Unsupported` on the `AlertRules` read | "Update the agent on m1-linux to set alerts" with the update action |
| Rule rejected on the host | `Answer::Error` with the `AlertRuleError` text, mapped to `CommandError::InvalidSettings` | Inline in the dialog; nothing saved |
| Agent cannot write `settings.json` | `Answer::Error` (I/O); the engine keeps the old rules | Inline in the dialog |
| Call times out | `Err` from `RemoteSource::call` | Inline; the dialog stays open, rules re-read on the next open |
| Agent history unavailable | rules evaluate, but no event is stored, so none syncs | Host settings already show history unavailable; Alerts repeats it under the rules |
| Delivery fails | existing `DeliveryOutcome::Failed` per destination | Existing "Failed 14:02 · HTTP 403" row |
| Alert state (floor) unreadable | logged; the floor restarts at now | Nothing is lost or delivered twice; earlier events are Timeline-only |

### 5.7 Cost

Evaluation on the agent is the existing detector path: a comparison per bound series per
tick, with the zero-allocation gate unchanged. Nothing new crosses the wire per tick. On
this Mac, ingest returns the few alert events it inserted, and delivery runs only for
those.

## 6. Phases

1. Agent: the two queries, live apply, cooldown seeding, the Mac host server's refusal
   through `ServedHost` defaults, the revision check and mutex, `drop_invalid` on load, and the `recent_alerts` move.
   Codec round-trip and skew tests for the new query and answer variants, including a
   rule list with one undecodable entry. `mem.psi` in `ALERT_METRICS` with
   `default_label: Some(("stall", "some"))`, and `cpu.loadavg` with
   `default_label: Some(("window", "5"))`.
2. Controller: commands, `Unsupported` mapped to the update state, inserted alert events from
   `IngestReport`, the floor, staleness on the corrected host clock, the host name in the
   notification, all through `fire::announce`.
3. Frontend: the host-scoped Alerts page and its states, the mock, Vitest and Playwright,
   with screenshots compared against the This Mac Alerts page.
4. Native acceptance against m1-linux: create a disk rule with a threshold that fires,
   see it on the phone through ntfy, sleep this Mac through a firing and check the
   catch-up message, update the agent and confirm the cooldown held.

## 7. Risks

- Two Macs paired to one agent both deliver its alerts. This is rare, and the agent
  delivering for itself removes it.
- Up to 5 minutes of delivery latency when this Mac is on battery.
- An agent with history unavailable evaluates rules but nothing reaches this Mac. Live
  event forwarding (5.4) would cover it.
- Alerts are only delivered while this Mac is awake and online, which the page states.
  An always-on server that needs to alert at 3 a.m. while the laptop is closed waits for
  the agent to deliver by itself.
- An agent on an older build than this Mac validates with its own limits; the error comes
  back as text, and a metric it does not know is refused there.
- `mem.psi` reads near zero on a healthy host (PSI `some` avg10, often below 0.01%), so
  its default threshold is a judgment call; it starts at 10% for 2 min and gets checked
  against m1-linux under real memory load before it ships.
- A load-average threshold depends on core count, so no single default suits every host.
  A new rule starts at 4 for 5 minutes, range 0.1 to 1000, and the user sets it for the
  host. Prefilling the host's core count is left out.

## 8. Decisions on the open questions

Both follow the common convention in server alerting.

1. Alerts more than 10 minutes old when they reach this Mac are grouped per host into one
   catch-up message (4.5), the way Alertmanager groups and phones collapse late
   notifications. Fresh alerts are delivered one by one.
2. `cpu.loadavg` is alertable (section 3), with the core-count caveat in section 7.

## 9. Review outcome

A ce:devils-advocate review checked revision 1 against the code. It confirmed that the agent
evaluates `Settings.alerts` with or without history, that alert events ride synced M1
pages on the 60 s / 300 s cycle, that `Threshold` causes round-trip, that `apply_settings`
swaps rules live, and that remote buses carry no events today. Revision 2 fixes what it
found: the feature flag would have been advertised by remote Macs too (revision 3 drops
the flag and keys on the host being a Linux agent); the query handler had no path to agent settings (now
`ServedHost` methods); concurrent saves could leave file and engine apart (mutex and
revision); the timestamp watermark could drop alerts after a clock step (now the mirror's
inserted events); the notification omitted the host; staleness used the agent's clock;
one newer rule could make the whole answer undecodable; the agent never dropped invalid
rules on load; seeding had no reader on the agent side; and the frontend has three gates,
not one. It also judged the summary-stream alternative rejected for the right reasons and
noted a third option, evaluating on this Mac over mirrored M1 rows, which lags by a sync
period and duplicates the evaluator.
