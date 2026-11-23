# RFC: Alerts you set, delivered to your phone

Status: Accepted for implementation, 2026-11-23. Execution plan: [plans/deliver-alerts.md](../plans/deliver-alerts.md).
Decision entry: D-138. Supersedes phase 2.3a of [v2](v2-customization-widgets.md) and takes the
host-offline part of phase 4.2c of [v4](v4-remote-hosts.md); the rest of 4.2c stays future work.

Related: D-083 (detectors and events), D-084 (built-in alert rules and notifications),
[rfc-ios-app.md](rfc-ios-app.md) open question 6 (alerts while the phone app is closed).

## 1. Problem

StatGlass can tell you after the fact what made the fans spin up. It cannot tell you at the time,
except for two fixed rules (a process above 200% CPU for 5 minutes, thermal state Serious) that
only post a macOS notification on the Mac that is having the problem.

Three people are not served today:

- The laptop user who wants to know when memory pressure stays high or the disk is nearly full,
  with their own threshold. Stats users ask for the same thing: a CPU temperature limit (16 +1),
  a "for more than x seconds" condition (open), swap alerts.
- The person away from the Mac. A notification on a Mac nobody is looking at tells nobody. The
  iPhone RFC excludes push alerts from its 1.0, and the phone app is many phases away.
- The person watching other machines. A saved host can go offline for hours and StatGlass says
  nothing until they open the Hosts page.

## 2. Jobs

Be told: "Tell me when memory pressure stays high, in my terms, not only about hot processes."

Be told wherever I am: "If my Mac or my server is in trouble while I'm out, my phone should buzz."

Trust it: "I need to see that a rule works and that the phone path works before I rely on it."

Success looks like this: a user creates a rule from a template in under a minute, sees a test
message arrive on their phone before leaving the page, and a week later can open the Alerts page
and see which rules fired and when.

## 3. Prior art

iStat Menus has per-metric notification rules with a threshold and a duration. Stats has
per-module notification levels and no duration (the open request). Beszel and Netdata, the
server-side tools, treat alerts plus a delivery channel as the core of the product; their top
requests are more alert kinds, not a phone app. The delivery pattern people already use for
homelab alerts is a notification relay: ntfy (open source, free hosted tier, self-hostable, an
app on both phone platforms), Pushover, or a chat webhook.

The pattern to follow: rules are a list of plain sentences ("Memory pressure above 80% for
2 min"), each with a switch; delivery channels are configured once and tested with a button.

## 4. Product decisions

1. Alerts gets its own page in the dashboard sidebar, between Containers and Settings. The Alerts
   panel leaves Settings. The page belongs to This Mac: it is hidden while a remote host is
   selected, as Containers is.
2. A custom rule is one metric, one comparison, one duration: "Memory pressure above 80% for
   2 min". The condition must hold on every reading for the whole duration. There is no average
   or maximum aggregation; a spike that ends does not fire. This is the existing `for_secs`
   meaning, and it is the one users describe.
3. The metric picker offers a short list Rust publishes, not the whole catalog: CPU usage, GPU
   usage, memory pressure, swap used, hottest sensor, fan speed, system power, battery charge and
   free disk space. Each comes with a sensible default threshold and duration, so picking a metric
   gives a working rule. Metrics this Mac does not measure are not offered.
4. For a metric with several series (fans, volumes), the rule watches any of them or one the user
   picks. A new disk rule starts on the boot volume, so a mounted installer image does not fire it.
5. Thresholds are entered in the units Settings already chose (°F or °C, GB or GiB) and stored in
   the metric's unit.
6. The two built-in rules stay as they are, as switch rows at the top of the list. They are not
   editable: their conditions (per-process CPU, thermal state) are not thresholds on a series.
7. Every fired alert does three things: a Timeline event, a macOS notification, and a message to
   every enabled destination. There is no per-rule routing in this version.
8. Destinations are ntfy and a generic webhook. ntfy is the recommended path to a phone: install
   the ntfy app, subscribe to a topic, done. The webhook posts JSON that Slack and Discord
   incoming webhooks accept, and anything else can parse.
9. Each destination has a "Send test" button and shows its last delivery ("Delivered 14:02" or
   "Failed 14:02 · HTTP 403"). A user must be able to prove the phone path before relying on it.
10. A third built-in rule, off by default: "A saved host is offline for 5 minutes", with one
    notice when it comes back. It is evaluated on this Mac, so it only works while this Mac is
    awake and online; the row says so.
11. A minimum cooldown of 1 minute and a default of 30 minutes per rule keep a flapping metric
    from flooding a phone. At most 32 custom rules.

### Not in this version

- Threshold rules on a remote host's metrics. The rule list is This Mac's. Evaluating rules on
  the agent and delivering from the server itself is the right design for servers (they alert
  while the Mac sleeps) and is the next step; the `statglass-notify` crate is placed so the agent
  can link it.
- "Would have fired N times" preview against history. The editor shows the metric's current value
  instead.
- Per-rule destinations, quiet hours, escalation, acknowledgement.
- Pushover, Telegram and email as named kinds. A webhook reaches most of them through a relay.
- Editing the built-in rules, and per-process or per-container rules.
- Opening the Timeline from a notification click (D-084 still applies).

## 5. Experience

The page is a `PageHeader` titled "Alerts" with a "New rule" button, then three panels in one
column, built from the settings row and panel components the Settings page uses. No card grid,
no stat tiles, no badges.

Rules. One row per rule: the sentence as the label, "Last fired 2 h ago" or "Never fired" as the
sub line (a link to the Timeline at that time when it has fired), a switch, and for custom rules
an edit button. Built-in rules come first. Switching any rule on sends the existing "Alerts are
on" confirmation notification so macOS asks for permission while the user is looking.

New rule and Edit open a dialog: a name (prefilled from the sentence and kept in step with it
until the user types their own), the metric select, "any" or one series where the metric has
several, above or below, the threshold with its unit, "for" (Right away, 30 s, 1, 2, 5, 10, 30
min), "then wait" before alerting again (1, 5, 15, 30 min, 1 h, 6 h, 24 h), the metric's value
right now, and Delete for an existing rule. Save writes one settings patch; a rejected rule shows
the reason inline and stays open.

Send to. A fixed first row, "Notifications on this Mac", then one row per destination: name, kind
and address as the sub line with the last delivery, a switch, "Send test" and an edit button.
"Add destination" opens a dialog with a kind control (ntfy, Webhook). The ntfy form has the
server (default `https://ntfy.sh`), a topic with a "Generate" button, an optional access token,
and three lines on subscribing from the phone. The webhook form has a URL. "Send test" works from
inside the dialog before saving.

Recent. The last 20 alerts over the past 7 days: time, the alert's sentence, and a link to the
Timeline at that moment. Empty: "No alerts in the last 7 days."

States: rules a Mac cannot evaluate (a module switched off, a metric this Mac lacks) show "Not
measured on this Mac" in place of the last-fired line and keep their switch. A destinations file
that cannot be read shows one inline message with the reason, and the page works with no
destinations. A failed save shows the error inline in the dialog.

## 6. Architecture

### 6.1 Where things live

| Thing | Owner | Why |
|---|---|---|
| Rule data, validation, the alertable-metric list, destination data | `statglass-schema` | Pure data every consumer agrees on |
| Custom rules | `Settings.alerts.rules`, next to the built-in switches | Settings already has single-writer persistence, revisions, validation, the `settings-changed` mirror and the engine hand-off; a second store would duplicate all of it |
| Threshold evaluation | `statglass-engine::detect` | Runs on the persisted tick with the other rules; zero allocation on a quiet tick |
| What an alert says, and sending it to a destination | new crate `statglass-notify` (depends on schema only) | Not Tauri-specific, and the Linux agent will need it |
| Destinations and their delivery state | `src-tauri/src/alerts/`, file `alert-destinations.json` (mode 0600) | They hold secrets (ntfy tokens, webhook URLs), so they stay out of Settings, which every window mirrors and the diagnostics export may include |
| Host-offline watch | `src-tauri/src/alerts/host_offline.rs`, a pure state machine fed by a 30 s poll of remote statuses | Connection state lives in the shell's `RemoteManager` |
| Labels and form state | `src/core/alerts.ts` | View-dependent shaping |

### 6.2 Data

`AlertSettings` gains `rules: Vec<AlertRule>` (custom rules) and `host_offline: bool`, both
`#[serde(default)]`, so an existing settings file decodes unchanged and the two built-in switches
keep their values. `AlertSettings` stops being `Copy`. Rules are validated when a patch is applied. On load, a rule that
does not decode or no longer validates is dropped with a warning and the rest of the file loads:
a failed settings load resets every setting, and one stale rule must not do that.

`Condition::Threshold { series, op, value }` already exists and becomes evaluated. `AlertCause`
gains `Threshold { metric, labels, value, op, threshold, for_secs }`, `HostOffline { host, name }` and
`HostBack { host, name, offline_secs }`. Events are stored and synced as CBOR; a build that does
not know a cause skips that row (D-083).

`ALERT_METRICS` is a Rust constant exported to TypeScript through `facts.rs`, like the other
generated constants: metric id, label, default comparison, default threshold, default duration,
and the accepted threshold range.

`Destination { id, name, enabled, kind }` with `DestinationKind::Ntfy { server, topic, token }`
and `DestinationKind::Webhook { url }`.

### 6.3 Evaluation

A threshold rule binds to every series its selector matches. Per series it keeps when the
condition started holding. A reading that fails the comparison clears that series. A series with
no reading for more than three of its own sampling periods is cleared too, so a rule never spans
a hole; sleep, a clock step and a relayout reset progress as they do for the other rules. The
rule fires when any series has held for `for_secs` and the cooldown has passed, naming that
series and its current value, and fires again only after no series satisfies the condition and
one holds again. Cooldowns survive restarts through the stored alert events, as today.

Changing a rule's definition replaces its evaluator and keeps its cooldown. Removing a rule drops
it.

### 6.4 Delivery

Delivery runs `/usr/bin/curl`, as the public-address lookup does, so the app gains no HTTP or TLS
stack (D-058). The whole request, URL and headers included, is passed as a curl config on stdin
(`curl -q -K -`), so no token or webhook URL appears in the process list. Only `http` and `https`
URLs are accepted, redirects are not followed, and a request times out after 10 seconds.

The config is `url`, `request = "POST"`, `header` and `data` lines, every value double-quoted with
backslash, quote, newline, carriage return and tab escaped, because rule and process names reach
the body and an unescaped quote or newline would let a value add config lines. Values containing
other control characters are rejected before curl runs. `-q` is the first argument, with
`--proto =http,https`, `--max-redirs 0`, `--max-time 10`, `--silent --show-error`,
`--output /dev/null` and `--write-out %{http_code}`. `--fail` is not used: the status code decides
the outcome (2xx delivered, 4xx failed without retry, 5xx retried) and curl's exit code names
transport failures (6 name not found, 7 could not connect, 28 timed out, 35 and 60 TLS).

ntfy is published as JSON to the server root (`{"topic", "title", "message", "priority", "tags"}`)
with `Authorization: Bearer` when a token is set. The webhook body is
`{"text", "content", "title", "message", "host", "rule", "fired_at_ms", "kind"}`; `text` and
`content` carry "title: message" for Slack and Discord.

A delivery is tried up to three times (after 2 s and 10 s) on a network error or a 5xx answer, and
once on a 4xx. There is no queue across restarts: an alert that could not be delivered is still a
Timeline event and a Mac notification, and the destination row shows the failure.

### 6.5 Error model

| Failure | Reported as | What the user sees |
|---|---|---|
| A rule fails validation (name, metric, range, duration, cooldown, too many, duplicate id) | `AlertRuleError` → `CommandError::InvalidSettings` with the reason | The dialog stays open with the reason inline; nothing is saved |
| Settings cannot be written | existing `settings_not_saved` | Same inline error; the rule list is unchanged |
| A rule's metric has no series on this Mac | not an error; the evaluator binds to nothing and never fires | "Not measured on this Mac" on the row |
| `alert-destinations.json` unreadable or malformed | logged with the cause; the file is renamed to `alert-destinations.json.bad`; the view carries `load_error` | One inline message on the page; no destinations |
| Destination fails validation (name, URL scheme, topic characters, more than 8) | `CommandError::Invalid` with the reason | Inline in the dialog |
| Destinations file cannot be written | `CommandError::Io` | Inline in the dialog; the in-memory list is unchanged |
| A delivery fails (curl missing, timeout, DNS, TLS, HTTP status) | `DeliveryOutcome::Failed { reason, detail }`, recorded per destination and emitted; a warning in the log with the destination id, never its URL or token | "Failed 14:02 · HTTP 403" on the row; "Send test" shows the same text at once |
| The local store cannot record a host-offline event | logged; the notification and deliveries still go out | The alert arrives; the Timeline lacks the pill |

Nothing in this table is swallowed: each failure either reaches the caller as a typed error or is
recorded as state the page shows.

### 6.6 Cost

A threshold rule's tick is a comparison per bound series. The detector allocation gate
(`engine.allocsPerTick.detectors: 0`) stays at zero with custom rules on. The host-offline watch
is one status read per 30 s and runs only while the rule is on and a host is saved. Delivery
spawns one short-lived `curl` per destination per alert, bounded by the 1 minute minimum
cooldown.

## 7. Risks

- A noisy rule trains the user to ignore alerts. Defaults come with durations, the cooldown has a
  floor, and Recent shows how often each rule fires.
- A public ntfy topic is readable by anyone who guesses it. Generated topics carry 96 bits of
  randomness, and the form says the topic is the password.
- Webhook payload compatibility with Slack is from documentation, not a test against Slack.
- Alerts evaluated on this Mac stop when it sleeps. The page says so on the host-offline row;
  agent-side evaluation is the fix and is out of scope.
- macOS notification delivery from a bundled, notarized build is still unobserved (D-084).

## 8. Verification

Rust tests for validation, evaluation edges (hold, clear, gap, cooldown, restart, several series,
rule edits), text, request building against a local HTTP listener through real `curl`, and the
host-offline state machine. Vitest for labels, form state and the mock. Playwright for creating,
editing and deleting a rule and adding and testing a destination against the mock transport.
Screenshots of the page in both themes compared with Settings and Hosts. A real ntfy delivery to a
generated topic, read back from ntfy's JSON endpoint. Native checks that stay open are listed in
PROGRESS when the work lands.
