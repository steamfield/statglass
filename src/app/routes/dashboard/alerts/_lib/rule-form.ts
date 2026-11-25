/**
 * Form state for one custom alert rule in the rule dialog: what the fields
 * hold, how a metric change resets them, how the form becomes a stored
 * `AlertRule`, and the one problem that blocks Save. Pure; no React.
 *
 * Limits come from the generated `ALERT_LIMITS` (name length, durations,
 * cooldowns) and `ALERT_METRICS` (threshold ranges), never from literals.
 * Rust validates again on save; its message is shown as is.
 */

import { formatAlertValue } from "@core/alert-values";
import {
  newRule,
  ruleSummary,
  thresholdFromDisplay,
  thresholdToDisplay,
} from "@core/alerts";
import { displayUnits } from "@core/format";
import {
  ALERT_LIMITS,
  ALERT_METRICS,
  type AlertMetric,
  type AlertRule,
  type Cmp,
  type UnitSettings,
} from "@core/generated/bindings";
import { HOUR_MS, MINUTE_MS } from "@core/time-grid";

/** The rule dialog's fields for one rule. */
export interface RuleForm {
  id: string;
  /** The name as typed or as kept in step with the sentence. */
  name: string;
  /**
   * True while the name follows the rule's sentence (`ruleSummary`): a new
   * rule, or a stored one whose name equals its sentence. Typing a name
   * clears it.
   */
  autoName: boolean;
  /** Catalog metric id, one of `ALERT_METRICS`. */
  metric: string;
  /** The watched series' labels; empty for every series ("Any"). */
  labels: Record<string, string>;
  op: Cmp;
  /** The threshold as the user sees and types it, in the display unit. */
  shown: string;
  /**
   * The threshold the form opened with, in the catalog unit, and the text
   * it was first shown as. While `shown` still reads as `storedShown`, Save
   * sends `storedValue` unchanged: converting the cut display text back
   * would move it (4e9 bytes shows as 3.72529 GiB, which is 3,999,999,738).
   */
  storedValue: number | null;
  storedShown: string;
  forSecs: number;
  cooldownSecs: number;
  enabled: boolean;
}

const SECOND_MS = 1000;

/** The threshold condition of a custom rule; built-in rules have none. */
function thresholdOf(rule: AlertRule) {
  if (!("threshold" in rule.when) || rule.when.threshold === undefined) {
    throw new Error(
      `rule form: rule ${rule.id} is not a threshold rule; only custom rules are edited`
    );
  }
  return rule.when.threshold;
}

/** A comma followed by exactly three digits: "1,000", "0,125". */
const COMMA_THEN_THREE_DIGITS = /,\d{3}(?!\d)/;

/**
 * True when a comma in `shown` may be a thousands separator: more than one
 * comma, a comma beside a dot ("1,000.5"), or a comma followed by exactly
 * three digits ("1,000"). Such text is refused rather than guessed at.
 */
function hasThousandsSeparator(shown: string): boolean {
  const commas = shown.split(",").length - 1;
  if (commas === 0) return false;
  return (
    commas > 1 || shown.includes(".") || COMMA_THEN_THREE_DIGITS.test(shown)
  );
}

/**
 * The typed threshold as a number; NaN when it is blank, not a number, or
 * may hold a thousands separator. A lone comma reads as the decimal
 * separator ("80,5" is 80.5).
 */
function parseShown(shown: string): number {
  const trimmed = shown.trim();
  if (trimmed === "" || hasThousandsSeparator(trimmed)) return Number.NaN;
  return Number(normalShown(trimmed));
}

/** `shown` as the parser reads it: trimmed, a lone decimal comma as a dot. */
function normalShown(shown: string): string {
  return shown.trim().replace(",", ".");
}

/**
 * The threshold to store in the catalog unit: the stored value itself while
 * the text still reads as it was shown, else the typed text converted.
 */
function thresholdOfForm(form: RuleForm, units: UnitSettings): number {
  if (
    form.storedValue !== null &&
    normalShown(form.shown) === normalShown(form.storedShown)
  ) {
    return form.storedValue;
  }
  return thresholdFromDisplay(form.metric, parseShown(form.shown), units);
}

/** `text` without a trailing `unit`: "500" from "500 rpm", "1" from "1%". */
function withoutUnit(text: string, unit: string): string {
  return unit !== "" && text.endsWith(unit)
    ? text.slice(0, -unit.length).trim()
    : text;
}

/**
 * The form for a stored rule: the threshold in the display unit
 * (`thresholdToDisplay`), `autoName` true when the name equals the rule's
 * `ruleSummary`. A `ge`/`le` comparison reads as `gt`/`lt`.
 */
export function formFromRule(rule: AlertRule, units: UnitSettings): RuleForm {
  const { series, op, value } = thresholdOf(rule);
  const shown =
    value === null
      ? ""
      : String(thresholdToDisplay(series.metric, value, units).value);
  return {
    id: rule.id,
    name: rule.name,
    autoName: rule.name === ruleSummary(rule, units),
    metric: series.metric,
    labels: Object.fromEntries(series.labels),
    op: op === "gt" || op === "ge" ? "gt" : "lt",
    shown,
    storedValue: value,
    storedShown: shown,
    forSecs: rule.for_secs,
    cooldownSecs: rule.cooldown_secs,
    enabled: rule.enabled,
  };
}

/**
 * The form for a new rule on `metric`: its default comparison, threshold
 * (display unit), duration and series (`default_label`, so Free disk space
 * starts on "/"), a 30 minute cooldown, enabled, and the rule's sentence as
 * an automatic name.
 */
export function formForMetric(
  metric: AlertMetric,
  id: string,
  units: UnitSettings
): RuleForm {
  const rule = newRule(metric, id);
  return {
    ...formFromRule(rule, units),
    name: ruleSummary(rule, units),
    autoName: true,
  };
}

/**
 * `form` moved to `metric`: that metric's defaults for comparison,
 * threshold, duration and series. A typed name (`autoName` false) is kept;
 * an automatic one becomes the new sentence. Id, cooldown and enabled stay.
 */
export function withMetric(
  form: RuleForm,
  metric: AlertMetric,
  units: UnitSettings
): RuleForm {
  const fresh = formForMetric(metric, form.id, units);
  return {
    ...fresh,
    name: form.autoName ? fresh.name : form.name,
    autoName: form.autoName,
    cooldownSecs: form.cooldownSecs,
    enabled: form.enabled,
  };
}

/**
 * `form` with `change` applied. While the name is automatic it follows the
 * new sentence; a threshold that is not a number leaves it as it was.
 */
export function withChange(
  form: RuleForm,
  change: Partial<
    Omit<
      RuleForm,
      "id" | "metric" | "name" | "autoName" | "storedValue" | "storedShown"
    >
  >,
  units: UnitSettings
): RuleForm {
  const next = { ...form, ...change };
  if (!next.autoName || !Number.isFinite(parseShown(next.shown))) return next;
  return { ...next, name: ruleSummary(ruleFromForm(next, units), units) };
}

/**
 * The rule to store: the name trimmed (Rust rejects surrounding spaces),
 * the threshold as stored when its text is untouched, else the shown text
 * converted to the catalog unit (`thresholdFromDisplay`), labels as one
 * `[key, value]` pair or none. Call only when `formProblem` is null.
 */
export function ruleFromForm(form: RuleForm, units: UnitSettings): AlertRule {
  return {
    id: form.id,
    name: form.name.trim(),
    when: {
      threshold: {
        series: { metric: form.metric, labels: Object.entries(form.labels) },
        op: form.op,
        value: thresholdOfForm(form, units),
      },
    },
    for_secs: form.forSecs,
    cooldown_secs: form.cooldownSecs,
    enabled: form.enabled,
  };
}

/**
 * "Between 500 and 20,000 rpm" when `shown` is outside the metric's range,
 * else null. The bounds read as `formatAlertValue` writes them.
 */
function rangeProblem(
  metric: string,
  shown: number,
  units: UnitSettings
): string | null {
  const entry = ALERT_METRICS.find((m) => m.metric === metric);
  if (!entry || entry.min === null || entry.max === null) return null;
  const min = thresholdToDisplay(metric, entry.min, units);
  const max = thresholdToDisplay(metric, entry.max, units);
  if (shown >= min.value && shown <= max.value) return null;
  const display = displayUnits(units);
  const low = formatAlertValue(metric, entry.min, display);
  const high = formatAlertValue(metric, entry.max, display);
  return `Between ${withoutUnit(low, min.unit)} and ${high}`;
}

/**
 * What stops the form from saving, as inline text, or null:
 * - "Enter a number without thousands separators" when a comma in `shown`
 *   may group digits ("1,000", "1,000.5");
 * - "Enter a number" when `shown` is empty or not a finite number;
 * - "Between {min} and {max}" when it is outside the metric's `min`..`max`,
 *   both in the display unit and the unit once, after the maximum
 *   ("Between 1 and 100%", "Between 86 and 266 °F");
 * - "Give the rule a name" when the trimmed name is empty;
 * - "Use at most {ALERT_LIMITS.max_name_chars} characters" when the
 *   trimmed name is longer.
 * Checked in that order.
 */
export function formProblem(
  form: RuleForm,
  units: UnitSettings
): string | null {
  if (hasThousandsSeparator(form.shown.trim())) {
    return "Enter a number without thousands separators";
  }
  const shown = parseShown(form.shown);
  if (!Number.isFinite(shown)) return "Enter a number";
  const range = rangeProblem(form.metric, shown, units);
  if (range !== null) return range;
  const name = form.name.trim();
  if (name === "") return "Give the rule a name";
  if ([...name].length > ALERT_LIMITS.max_name_chars) {
    return `Use at most ${ALERT_LIMITS.max_name_chars} characters`;
  }
  return null;
}

/**
 * `rules` with `rule` saved: replacing the stored rule of the same id, its
 * `enabled` taken from the stored one (a switch flipped while the dialog was
 * open wins), or appended when no stored rule has that id (a new rule, or
 * one another window deleted while it was being edited).
 */
export function rulesWithSaved(
  rules: readonly AlertRule[],
  rule: AlertRule
): AlertRule[] {
  const stored = rules.find((r) => r.id === rule.id);
  if (stored === undefined) return [...rules, rule];
  return rules.map((r) =>
    r.id === rule.id ? { ...rule, enabled: stored.enabled } : r
  );
}

/**
 * A duration choice as the dialog's selects label it: "Right away", "30 s",
 * "5 min", "24 h".
 */
export function durationText(secs: number): string {
  const ms = secs * SECOND_MS;
  if (secs === 0) return "Right away";
  if (ms < MINUTE_MS) return `${secs} s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`;
  return `${Math.floor(ms / HOUR_MS)} h`;
}
