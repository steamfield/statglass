/**
 * One row of the Rules panel: a rule's label, sub line, switch and, for a
 * custom rule, its edit button.
 */
import type { ReactNode } from "react";
import { SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";

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
  /** Locks the switch and the edit button, while a rules write is pending. */
  disabled?: boolean;
}

/** A `SettingsRow` with a switch and, when `onEdit` is given, an edit button. */
export function RuleRow({
  label,
  sub,
  enabled,
  onEnabledChange,
  onEdit,
  disabled = false,
}: RuleRowProps): ReactNode {
  return (
    <SettingsRow label={label} sub={sub}>
      <div className="flex items-center gap-3">
        {onEdit && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${label}`}
            disabled={disabled}
            onClick={onEdit}
          >
            Edit
          </Button>
        )}
        <Switch
          aria-label={label}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
    </SettingsRow>
  );
}
