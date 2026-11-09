import type { UiModule } from "@core/module-state";
import { useId } from "react";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { Swatch } from "~/widgets/legend";
import { MODULE_META } from "~/widgets/lib/module-meta";

export interface ModuleToggleRowProps {
  module: UiModule;
  checked: boolean;
  /**
   * Why the host cannot run the module (`unavailableText`), shown in place
   * of `sub`; the switch is off and disabled. Null when it can run.
   */
  absence: string | null;
  /** The line under the name while the module can run. */
  sub?: string | undefined;
  onCheckedChange: (on: boolean) => void;
  /** Names the switch instead of the visible label ("CPU enabled"). */
  switchLabel?: string;
  /** The onboarding list: 42 px rows in a well, an 11 px truncated sub. */
  dense?: boolean;
}

/**
 * One module row: swatch, name, a sub line and the On switch. A module the
 * host lacks stays listed, disabled, with its absence in the sub line.
 */
export function ModuleToggleRow({
  module,
  checked,
  absence,
  sub,
  onCheckedChange,
  switchLabel,
  dense = false,
}: ModuleToggleRowProps) {
  const meta = MODULE_META[module];
  const on = absence === null && checked;
  const line = absence ?? sub;
  const switchId = useId();
  const Row = dense ? "li" : "div";
  return (
    <Row
      className={cn(
        "flex items-center border-border-subtle border-b last:border-b-0",
        dense ? "h-[42px] gap-2.5 px-3" : "min-h-12 gap-3 px-4 text-body"
      )}
    >
      <Swatch
        step="none"
        color={`var(--color-${meta.accent})`}
        className={cn(absence !== null && "opacity-40")}
      />
      <div className={cn("flex min-w-0 flex-1 flex-col", !dense && "py-2")}>
        <label
          htmlFor={switchId}
          className={cn(
            dense && "text-body",
            // Onboarding mutes only an absent module; settings, any that is off.
            (dense ? absence !== null : !on) && "text-muted-foreground"
          )}
        >
          {meta.name}
        </label>
        {line && (
          <span
            className={cn(
              "font-normal text-muted-foreground",
              dense ? "truncate text-label" : "text-small"
            )}
          >
            {line}
          </span>
        )}
      </div>
      <Switch
        id={switchId}
        checked={on}
        disabled={absence !== null}
        aria-label={switchLabel}
        onCheckedChange={onCheckedChange}
      />
    </Row>
  );
}

export interface ModuleToggleItem {
  id: UiModule;
  enabled: boolean;
  /** `unavailableText` for a module the host cannot run, else null. */
  absence: string | null;
}

export interface ModuleToggleListProps {
  modules: readonly ModuleToggleItem[];
  onToggle: (id: UiModule, enabled: boolean) => void;
}

/** Onboarding's module rows, each with its description, in a well. */
export function ModuleToggleList({ modules, onToggle }: ModuleToggleListProps) {
  return (
    <ul className="rounded-tile border border-border bg-well">
      {modules.map((m) => (
        <ModuleToggleRow
          key={m.id}
          dense
          module={m.id}
          checked={m.enabled}
          absence={m.absence}
          sub={MODULE_META[m.id].description}
          onCheckedChange={(on) => onToggle(m.id, on)}
        />
      ))}
    </ul>
  );
}
