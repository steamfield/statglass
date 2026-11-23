/**
 * Form state for one custom alert rule in the rule dialog: what the fields
 * hold, how a metric change resets them, how the form becomes a stored
 * `AlertRule`, and the one problem that blocks Save. Pure; no React.
 *
 * Limits come from the generated `ALERT_LIMITS` (name length, durations,
 * cooldowns) and `ALERT_METRICS` (threshold ranges), never from literals.
 * Rust validates again on save; its message is shown as is.
 */
import type {
  AlertMetric,
  AlertRule,
  UnitSettings,
} from "@core/generated/bindings";

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
  op: "gt" | "lt";
  /** The threshold as the user sees and types it, in the display unit. */
  shown: string;
  forSecs: number;
  cooldownSecs: number;
  enabled: boolean;
}

/**
 * The form for a stored rule: the threshold in the display unit
 * (`thresholdToDisplay`), `autoName` true when the name equals the rule's
 * `ruleSummary`. A `ge`/`le` comparison reads as `gt`/`lt`.
 */
export function formFromRule(_rule: AlertRule, _units: UnitSettings): RuleForm {
  throw new Error("not implemented");
}

/**
 * The form for a new rule on `metric`: its default comparison, threshold
 * (display unit), duration and series (`default_label`, so Free disk space
 * starts on "/"), a 30 minute cooldown, enabled, and the rule's sentence as
 * an automatic name.
 */
export function formForMetric(
  _metric: AlertMetric,
  _id: string,
  _units: UnitSettings
): RuleForm {
  throw new Error("not implemented");
}

/**
 * `form` moved to `metric`: that metric's defaults for comparison,
 * threshold, duration and series. A typed name (`autoName` false) is kept;
 * an automatic one becomes the new sentence. Id, cooldown and enabled stay.
 */
export function withMetric(
  _form: RuleForm,
  _metric: AlertMetric,
  _units: UnitSettings
): RuleForm {
  throw new Error("not implemented");
}

/**
 * The rule to store: the name trimmed (Rust rejects surrounding spaces),
 * the shown threshold converted to the catalog unit
 * (`thresholdFromDisplay`), labels as one `[key, value]` pair or none.
 * Call only when `formProblem` is null.
 */
export function ruleFromForm(_form: RuleForm, _units: UnitSettings): AlertRule {
  throw new Error("not implemented");
}

/**
 * What stops the form from saving, as inline text, or null:
 * - "Enter a number" when `shown` is empty or not a finite number;
 * - "Between {min} and {max}{unit}" when it is outside the metric's
 *   `min`..`max`, both in the display unit, the unit after a space except
 *   "%" ("Between 1 and 100%", "Between 86 and 266 °F");
 * - "Give the rule a name" when the trimmed name is empty;
 * - "Use at most {ALERT_LIMITS.max_name_chars} characters" when the
 *   trimmed name is longer.
 * Checked in that order.
 */
export function formProblem(
  _form: RuleForm,
  _units: UnitSettings
): string | null {
  throw new Error("not implemented");
}
