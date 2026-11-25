/**
 * Custom alert rules for the Alerts page (plan/rfc-alerts.md): rule
 * sentences and alert labels in the user's units, the metrics and series a
 * rule may watch, a new rule's defaults and when each rule last fired. Rust
 * validates rules and owns the notification wording. `@core/alert-values`
 * formats values and converts threshold units.
 */
import { formatAlertValue } from "@core/alert-values";
import { displayUnits, formatPercent } from "@core/format";
import {
  ALERT_METRICS,
  type AlertCause,
  type AlertMetric,
  type AlertRule,
  type Cmp,
  type Event,
  type Labels,
  type UnitSettings,
} from "@core/generated/types";
import { parseLabels } from "@core/series-key";
import { THERMAL_LABEL } from "@core/thermal";

// The rule dialog's tests import the conversions from here.
export { thresholdFromDisplay, thresholdToDisplay } from "@core/alert-values";

/** The "for" choices of the rule dialog, in seconds ("Right away" is 0). */
export const FOR_CHOICES_SECS: readonly number[] = [
  0, 30, 60, 120, 300, 600, 1800,
];

/** The "then wait" (cooldown) choices of the rule dialog, in seconds. */
export const COOLDOWN_CHOICES_SECS: readonly number[] = [
  60, 300, 900, 1800, 3600, 21_600, 86_400,
];

/** One series a rule may watch, or every series ("Any", no labels). */
export interface SeriesChoice {
  label: string;
  labels: Record<string, string>;
}

/** The cooldown a new rule starts with: 30 minutes. */
const NEW_RULE_COOLDOWN_SECS = 1800;

/** Durations below this read in seconds, longer ones in whole minutes. */
const SECONDS_WORDING_BELOW = 120;

const FAN_METRIC = "fan.rpm";
const FAN_LABEL = "fan";

/** "30 s" under two minutes, whole minutes rounded down from there. */
function formatHold(secs: number): string {
  if (secs < SECONDS_WORDING_BELOW) return `${secs} s`;
  return `${Math.floor(secs / 60)} min`;
}

/** "above" for gt and ge, "below" for lt and le. */
function comparisonWord(op: Cmp): string {
  return op === "gt" || op === "ge" ? "above" : "below";
}

/** "Fan speed (Fan 1)", or just "Memory pressure" for every series. */
function seriesLabel(metric: string, labels: Labels): string {
  const definition = ALERT_METRICS.find((m) => m.metric === metric);
  const label = definition?.label ?? metric;
  const first = labels[0];
  if (first === undefined) {
    const qualifier = definition?.unlabelled_qualifier;
    return qualifier ? `${label} (${qualifier})` : label;
  }
  const [key, value] = first;
  if (
    key === definition?.default_label?.[0] &&
    value === definition.bare_label_value
  )
    return label;
  const name = seriesName(metric, Object.fromEntries(labels));
  return name === null ? label : `${label} (${name})`;
}

/** The metric part of a display-form key: "fan.rpm" from "fan.rpm{fan=0}". */
function metricOfKey(key: string): string {
  const open = key.indexOf("{");
  return open < 0 ? key : key.slice(0, open);
}

/**
 * A custom rule as a sentence such as "Memory pressure above 80% for 2 min".
 * Throws for a built-in rule, which has no threshold to describe.
 */
export function ruleSummary(rule: AlertRule, units: UnitSettings): string {
  if (!("threshold" in rule.when) || rule.when.threshold === undefined) {
    throw new Error(
      `ruleSummary: rule ${rule.id} is not a threshold rule; only custom rules have a summary`
    );
  }
  const { series, op, value } = rule.when.threshold;
  const shown = formatAlertValue(series.metric, value, displayUnits(units));
  const hold = rule.for_secs > 0 ? ` for ${formatHold(rule.for_secs)}` : "";
  return `${seriesLabel(series.metric, series.labels)} ${comparisonWord(op)} ${shown}${hold}`;
}

/**
 * How long a host was offline: "42 min" under an hour, then "1 h 12 min"
 * or "3 h". Whole minutes, rounded down, as Rust's notification says them.
 */
function offlineSpan(secs: number): string {
  const minutes = Math.floor(secs / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * What an alert's cause measured, in the user's units: "Memory pressure
 * 84%", "Fan speed (Fan 2) 5,200 rpm", "ffmpeg at 251% CPU", "thermal
 * state Serious", "m1-linux is offline", "m1-linux is back after 42 min".
 * `null` units take the display defaults (°F, GB), as `displayUnits` does.
 */
export function alertCauseLabel(
  cause: AlertCause,
  units: UnitSettings | null
): string {
  switch (cause.type) {
    case "process_cpu":
      return `${cause.process} at ${formatPercent(cause.cpu_pct)} CPU`;
    case "thermal_state":
      return `thermal state ${THERMAL_LABEL[cause.state]}`;
    case "threshold": {
      const shown = formatAlertValue(
        cause.metric,
        cause.value,
        displayUnits(units)
      );
      return `${seriesLabel(cause.metric, cause.labels)} ${shown}`;
    }
    case "host_offline":
      return `${cause.name} is offline`;
    case "host_back":
      return `${cause.name} is back after ${offlineSpan(cause.offline_secs)}`;
  }
}

/**
 * The `ALERT_METRICS` entries this host measures: those with at least one
 * live series among `seriesKeys` (display-form keys, "fan.rpm{fan=0}").
 */
export function availableMetrics(seriesKeys: readonly string[]): AlertMetric[] {
  const live = new Set(seriesKeys.map(metricOfKey));
  return ALERT_METRICS.filter((m) => live.has(m.metric)).map((m) => ({
    ...m,
    default_label: m.default_label ? [...m.default_label] : null,
  }));
}

/**
 * The series a rule on `metric` may watch: "Any" first, then one entry per
 * live labelled series, named by `seriesName`. An unlabelled series is
 * covered by "Any" and gets no entry of its own.
 */
export function seriesChoices(
  metric: string,
  seriesKeys: readonly string[]
): SeriesChoice[] {
  const choices: SeriesChoice[] = [{ label: "Any", labels: {} }];
  for (const key of seriesKeys) {
    if (metricOfKey(key) !== metric) continue;
    const labels = parseLabels(key);
    const name = seriesName(metric, labels);
    if (name !== null) choices.push({ label: name, labels });
  }
  return choices;
}

/**
 * A new, enabled rule on `metric` named after it, with its default
 * comparison, threshold, duration and series (`default_label`), and a 30
 * minute cooldown.
 */
export function newRule(metric: AlertMetric, id: string): AlertRule {
  const labels: Labels = metric.default_label
    ? [[...metric.default_label]]
    : [];
  return {
    id,
    name: metric.label,
    when: {
      threshold: {
        series: { metric: metric.metric, labels },
        op: metric.default_op,
        value: metric.default_value,
      },
    },
    for_secs: metric.default_for_secs,
    cooldown_secs: NEW_RULE_COOLDOWN_SECS,
    enabled: true,
  };
}

/**
 * The display name of one series from its first label, with a catalog unit
 * for numeric labels where configured. Fans are numbered from one.
 */
export function seriesName(
  metric: string,
  labels: Record<string, string>
): string | null {
  const first = Object.entries(labels)[0];
  if (first === undefined) return null;
  const [key, value] = first;
  if (metric === FAN_METRIC && key === FAN_LABEL && /^\d+$/.test(value)) {
    return `Fan ${Number(value) + 1}`;
  }
  const definition = ALERT_METRICS.find((m) => m.metric === metric);
  if (
    definition?.numeric_label_unit &&
    key === definition.default_label?.[0] &&
    /^\d+$/.test(value)
  ) {
    return `${value} ${definition.numeric_label_unit}`;
  }
  return value;
}

/**
 * The newest alert event per rule id among `events`: when each rule last
 * fired. A `host_back` cause is the recovery notice of a rule that fired
 * earlier, not a firing, so it is skipped. Other events are ignored.
 */
export function lastFiredByRule(events: readonly Event[]): Map<string, Event> {
  const newest = new Map<string, Event>();
  for (const event of events) {
    const detail = event.detail;
    if (detail.kind !== "alert" || detail.cause.type === "host_back") continue;
    const seen = newest.get(detail.rule_id);
    if (seen === undefined || event.ts_ms > seen.ts_ms) {
      newest.set(detail.rule_id, event);
    }
  }
  return newest;
}
