/**
 * Custom alert rules for the Alerts page (plan/rfc-alerts.md): rule
 * sentences and alert labels in the user's units, the metrics and series a
 * rule may watch, a new rule's defaults, threshold unit conversion and when
 * each rule last fired. Rust validates rules and owns the notification
 * wording; the sentences here match it for the same rule.
 */
import type {
  AlertCause,
  AlertMetric,
  AlertRule,
  Event,
  UnitSettings,
} from "@core/generated/bindings";

/** The "for" choices of the rule dialog, in seconds ("Right away" is 0). */
export const FOR_CHOICES_SECS: readonly number[] = [];

/** The "then wait" (cooldown) choices of the rule dialog, in seconds. */
export const COOLDOWN_CHOICES_SECS: readonly number[] = [];

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

/**
 * A custom rule as one sentence, as Rust's `rule_summary` writes it:
 * "Memory pressure above 80% for 2 min", "Free disk space (/) below 20 GB".
 */
export function ruleSummary(_rule: AlertRule, _units: UnitSettings): string {
  throw new Error("not implemented");
}

/**
 * What an alert's cause measured, in the user's units: "Memory pressure
 * 84%", "Fan speed (Fan 2) 5,200 rpm", "ffmpeg at 251% CPU". `null` units
 * take the display defaults (°F, GB), as `displayUnits` does.
 */
export function alertCauseLabel(
  _cause: AlertCause,
  _units: UnitSettings | null
): string {
  throw new Error("not implemented");
}

/**
 * The `ALERT_METRICS` entries this host measures: those with at least one
 * live series among `seriesKeys` (display-form keys, "fan.rpm{fan=0}").
 */
export function availableMetrics(
  _seriesKeys: readonly string[]
): AlertMetric[] {
  throw new Error("not implemented");
}

/**
 * The series a rule on `metric` may watch: "Any" first, then one entry per
 * live series, named by `seriesName`.
 */
export function seriesChoices(
  _metric: string,
  _seriesKeys: readonly string[]
): SeriesChoice[] {
  throw new Error("not implemented");
}

/**
 * A new, enabled rule on `metric` with its default comparison, threshold,
 * duration and series (`default_label`), and a 30 minute cooldown.
 */
export function newRule(_metric: AlertMetric, _id: string): AlertRule {
  throw new Error("not implemented");
}

/**
 * The display name of one series, as Rust's `series_name` gives it: `null`
 * without labels, "Fan {n+1}" for `fan.rpm` with a numeric `fan` label,
 * otherwise the single label's value.
 */
export function seriesName(
  _metric: string,
  _labels: Record<string, string>
): string | null {
  throw new Error("not implemented");
}

/**
 * A stored threshold (catalog unit) in the unit the user enters it in: °F
 * when set, GB or GiB for bytes (GiB only for `mem.*` with the binary
 * memory setting), the catalog unit otherwise.
 */
export function thresholdToDisplay(
  _metric: string,
  _value: number,
  _units: UnitSettings
): DisplayThreshold {
  throw new Error("not implemented");
}

/** The inverse of `thresholdToDisplay`: an entered value in the catalog unit. */
export function thresholdFromDisplay(
  _metric: string,
  _shown: number,
  _units: UnitSettings
): number {
  throw new Error("not implemented");
}

/** The newest alert time (`ts_ms`) per rule id among `events`. */
export function lastFiredByRule(
  _events: readonly Event[]
): Map<string, number> {
  throw new Error("not implemented");
}
