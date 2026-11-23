/**
 * The rule editor: a dialog over one custom rule's form (`_lib/rule-form`),
 * saved as one settings patch.
 */
import type { AlertRule } from "@core/generated/bindings";
import type { ReactNode } from "react";

/** The rule the dialog edits, and whether Save appends it or replaces it. */
export interface RuleDraft {
  rule: AlertRule;
  isNew: boolean;
}

/** Props of `RuleDialog`. */
export interface RuleDialogProps {
  /** The rule to edit; null keeps the dialog closed. */
  draft: RuleDraft | null;
  /** Close without anything further: after Save, Delete, Cancel or Escape. */
  onClose: () => void;
}

/**
 * The "New rule" / "Edit rule" dialog. Fields labelled "Name", "Metric",
 * "Watch" (only for a labelled metric: "Any", then series names), "When it
 * is" (above, below), "Threshold" with its display unit, "For" and "Then
 * wait"; a "Now" line with the watched series' current value, the only part
 * that renders on a live tick; `formProblem` text inline with Save
 * disabled. Save sends `{ alerts: { rules } }` with the rule appended (new)
 * or replaced (edit) through `updateSettings` and closes; a rejected save
 * shows its message inline and keeps the form. Delete (existing rules only)
 * removes the rule and closes. Cancel and Escape write nothing.
 */
export function RuleDialog(_props: RuleDialogProps): ReactNode {
  return null;
}
