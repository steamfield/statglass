/**
 * The Alerts page's Rules panel: the built-in rules, then the user's
 * threshold rules, one switch row each.
 */
import type { AlertRule } from "@core/generated/bindings";
import type { ReactNode } from "react";

/** Props of `RulesPanel`. */
export interface RulesPanelProps {
  /** Open the editor on a custom rule ("Edit <rule name>"). */
  onEdit: (rule: AlertRule) => void;
}

/**
 * A `SettingsPanel` titled "Rules". The two built-in rows come first
 * ("A process above 200% CPU for 5 minutes", "Thermal state Serious or
 * worse") and write `{ alerts: { hot_process } }` / `{ alerts: {
 * thermal_serious } }`. Each custom row's label is the rule name; its sub
 * line is the sentence when the name differs from it, then "Last fired
 * <relative time>" opening the Timeline at that alert, "Never fired", or
 * "Not measured on this Mac" when no live series has its metric. Its switch
 * (named by the rule name) writes the whole rules list with that rule's
 * `enabled` flipped. Does not re-render on a live tick.
 */
export function RulesPanel(_props: RulesPanelProps): ReactNode {
  return null;
}
