/**
 * Custom alert rules for the Alerts page (plan/rfc-alerts.md): rule
 * sentences and alert labels in the user's units, the metrics and series a
 * rule may watch, a new rule's defaults, threshold unit conversion and when
 * each rule last fired. Rust validates rules and owns the notification
 * wording; the sentences here match it for the same rule.
 */
import {
  bytesParts,
  type DisplayUnits,
  displayUnits,
  fixed,
  formatInteger,
  formatPercent,
  formatTemperature,
  isPresent,
  MISSING,
} from "@core/format";
import {
  ALERT_METRICS,
  type AlertCause,
  type AlertMetric,
  type AlertRule,
  type Cmp,
  type Event,
  type Labels,
  METRIC_UNITS,
  type UnitSettings,
} from "@core/generated/bindings";
import { parseLabels } from "@core/series-key";
import { THERMAL_LABEL } from "@core/thermal";

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

/** A threshold in the unit the user reads it in. */
export interface DisplayThreshold {
  value: number;
  unit: string;
}

/** The cooldown a new rule starts with: 30 minutes. */
const NEW_RULE_COOLDOWN_SECS = 1800;

/** Durations below this read in seconds, longer ones in whole minutes. */
const SECONDS_WORDING_BELOW = 120;

/** Watts below this read with one decimal, as Rust's `format_value` does. */
const WATTS_DECIMAL_BELOW = 10;

const BYTES_PER_GB = 1e9;
const BYTES_PER_GIB = 2 ** 30;

/** The unit text of each catalog unit an alertable metric reads in. */
const UNIT_TEXT: Readonly<Record<string, string>> = {
  percent: "%",
  rpm: "rpm",
  watts: "W",
  pages_per_sec: "pages/s",
};

/** The catalog unit of `metric`, or undefined for a metric this build lacks. */
function catalogUnit(metric: string): string | undefined {
  return (METRIC_UNITS as Readonly<Record<string, string>>)[metric];
}

/** What a rule sentence calls `metric`: its alert label, else its id. */
function metricLabel(metric: string): string {
  return ALERT_METRICS.find((m) => m.metric === metric)?.label ?? metric;
}

/** The byte unit `metric` reads in: memory follows the setting, disk is GB. */
function byteUnitOf(metric: string, units: DisplayUnits): "GB" | "GiB" {
  return metric.startsWith("mem.") ? units.bytes : "GB";
}

/** Bytes pinned to GB or GiB with one decimal, a trailing ".0" dropped. */
function formatShortBytes(bytes: number, unit: "GB" | "GiB"): string {
  const parts = bytesParts(bytes, { units: unit, unit, decimals: 1 });
  return `${parts.value.replace(/\.0$/, "")} ${parts.unit}`;
}

/** One value of `metric` in the user's units: "84%", "4,000 rpm", "20 GB". */
function formatMetricValue(
  metric: string,
  value: number | null,
  units: DisplayUnits
): string {
  if (!isPresent(value)) return MISSING;
  switch (catalogUnit(metric)) {
    case "percent":
      return formatPercent(value);
    case "celsius":
      return formatTemperature(value, { units: units.temperature });
    case "bytes":
      return formatShortBytes(value, byteUnitOf(metric, units));
    case "watts":
      return `${fixed(value, value < WATTS_DECIMAL_BELOW ? 1 : 0)} W`;
    case "rpm":
      return `${formatInteger(value)} rpm`;
    case "pages_per_sec":
      return `${formatInteger(value)} pages/s`;
    default:
      return formatInteger(value);
  }
}

/** "30 s" under two minutes, whole minutes from there ("2 min"). */
function formatHold(secs: number): string {
  if (secs < SECONDS_WORDING_BELOW) return `${secs} s`;
  return `${Math.round(secs / 60)} min`;
}

/** "above" for gt and ge, "below" for lt and le. */
function comparisonWord(op: Cmp): string {
  return op === "gt" || op === "ge" ? "above" : "below";
}

/** "Fan speed (Fan 1)", or just "Memory pressure" for every series. */
function seriesLabel(metric: string, labels: Labels): string {
  const name = seriesName(metric, Object.fromEntries(labels));
  const label = metricLabel(metric);
  return name === null ? label : `${label} (${name})`;
}

/** The metric part of a display-form key: "fan.rpm" from "fan.rpm{fan=0}". */
function metricOfKey(key: string): string {
  const open = key.indexOf("{");
  return open < 0 ? key : key.slice(0, open);
}

/**
 * A custom rule as one sentence, as Rust's `rule_summary` writes it:
 * "Memory pressure above 80% for 2 min", "Free disk space (/) below 20 GB".
 * Throws for a built-in rule, which has no threshold to describe.
 */
export function ruleSummary(rule: AlertRule, units: UnitSettings): string {
  if (!("threshold" in rule.when) || rule.when.threshold === undefined) {
    throw new Error(
      `ruleSummary: rule ${rule.id} is not a threshold rule; only custom rules have a summary`
    );
  }
  const { series, op, value } = rule.when.threshold;
  const shown = formatMetricValue(series.metric, value, displayUnits(units));
  const hold = rule.for_secs > 0 ? ` for ${formatHold(rule.for_secs)}` : "";
  return `${seriesLabel(series.metric, series.labels)} ${comparisonWord(op)} ${shown}${hold}`;
}

/**
 * What an alert's cause measured, in the user's units: "Memory pressure
 * 84%", "Fan speed (Fan 2) 5,200 rpm", "ffmpeg at 251% CPU", "thermal state
 * Serious". `null` units
 * take the display defaults (°F, GB), as `displayUnits` does.
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
      const shown = formatMetricValue(
        cause.metric,
        cause.value,
        displayUnits(units)
      );
      return `${seriesLabel(cause.metric, cause.labels)} ${shown}`;
    }
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
 * The display name of one series, as Rust's `series_name` gives it: `null`
 * without labels, "Fan {n+1}" for `fan.rpm` with a numeric `fan` label,
 * otherwise the label values joined with ", " (a rule carries one).
 */
export function seriesName(
  metric: string,
  labels: Record<string, string>
): string | null {
  const values = Object.values(labels);
  if (values.length === 0) return null;
  const fan = labels.fan;
  if (metric === "fan.rpm" && fan !== undefined && /^\d+$/.test(fan)) {
    return `Fan ${Number(fan) + 1}`;
  }
  return values.join(", ");
}

/**
 * A stored threshold (catalog unit) in the unit the user enters it in: °F
 * when set, GB or GiB for bytes (GiB only for `mem.*` with the binary
 * memory setting), the catalog unit otherwise. The value is not rounded.
 */
export function thresholdToDisplay(
  metric: string,
  value: number,
  units: UnitSettings
): DisplayThreshold {
  const shown = displayUnits(units);
  const unit = catalogUnit(metric);
  if (unit === "celsius" && shown.temperature === "F") {
    return { value: (value * 9) / 5 + 32, unit: "°F" };
  }
  if (unit === "celsius") return { value, unit: "°C" };
  if (unit === "bytes") {
    const bytesUnit = byteUnitOf(metric, shown);
    return { value: value / bytesPerUnit(bytesUnit), unit: bytesUnit };
  }
  return { value, unit: UNIT_TEXT[unit ?? ""] ?? "" };
}

/** The inverse of `thresholdToDisplay`: an entered value in the catalog unit. */
export function thresholdFromDisplay(
  metric: string,
  shown: number,
  units: UnitSettings
): number {
  const display = displayUnits(units);
  const unit = catalogUnit(metric);
  if (unit === "celsius" && display.temperature === "F") {
    return ((shown - 32) * 5) / 9;
  }
  if (unit === "bytes") {
    return shown * bytesPerUnit(byteUnitOf(metric, display));
  }
  return shown;
}

/** Bytes in one GB or one GiB. */
function bytesPerUnit(unit: "GB" | "GiB"): number {
  return unit === "GiB" ? BYTES_PER_GIB : BYTES_PER_GB;
}

/** The newest alert time (`ts_ms`) per rule id among `events`. */
export function lastFiredByRule(events: readonly Event[]): Map<string, number> {
  const newest = new Map<string, number>();
  for (const event of events) {
    if (event.detail.kind !== "alert") continue;
    const ruleId = event.detail.rule_id;
    const seen = newest.get(ruleId);
    if (seen === undefined || event.ts_ms > seen) {
      newest.set(ruleId, event.ts_ms);
    }
  }
  return newest;
}
