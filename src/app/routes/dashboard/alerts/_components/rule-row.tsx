/**
 * One row of the Rules panel: a rule's label, sub line, switch and, for a
 * custom rule, its edit button.
 */
import type { ReactNode } from "react";

/** Props of `RuleRow`. */
export interface RuleRowProps {
  /** The rule name; also the switch's accessible name. */
  label: string;
  /** The sentence and last-fired line, or the "Not measured" text. */
  sub?: ReactNode;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Present for custom rules: the "Edit <label>" button. */
  onEdit?: (() => void) | undefined;
}

/** A `SettingsRow` with a switch and, when `onEdit` is given, an edit button. */
export function RuleRow(_props: RuleRowProps): ReactNode {
  return null;
}
