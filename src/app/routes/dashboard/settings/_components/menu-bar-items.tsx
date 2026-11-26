/**
 * The Menu bar panel's separate-items block: per module, whether it gets its
 * own place in the menu bar and in which form.
 */
import type { MenuBarSettings } from "@core/generated/types";
import {
  itemModeLabel,
  itemModes,
  itemPatch,
  SETTINGS_MODULES,
  type SettingsModule,
} from "@core/settings-patch";
import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { cn } from "~/lib/utils";
import { FIELD_LABEL } from "~/widgets/lib/classes";
import { MODULE_META } from "~/widgets/lib/module-meta";

// No `last:` border rule: these rows sit inside a wrapper, not the panel.
const ROW =
  "flex min-h-10 items-center gap-3 border-border-subtle border-b px-4 text-body";

type ItemMode = MenuBarSettings["items"][SettingsModule];

/** One module's row: its name, why it is off, and the item-mode select. */
function ItemRow({
  module,
  mode,
  off,
  locked,
}: {
  module: SettingsModule;
  mode: ItemMode;
  off: ReactNode;
  locked: boolean;
}) {
  const write = useWriteSettings();
  const id = `settings-item-${module}`;
  const name = MODULE_META[module].name;
  return (
    <div className={ROW}>
      <div className="flex min-w-0 flex-1 flex-col py-2">
        <label htmlFor={id} className={cn(off && "text-muted-foreground")}>
          {name}
        </label>
        {off && (
          <span className="font-normal text-muted-foreground text-small">
            {off}
          </span>
        )}
      </div>
      <Select
        value={off ? "off" : mode}
        disabled={locked || Boolean(off)}
        onValueChange={(next) => write(itemPatch(module, next as ItemMode))}
      >
        <SelectTrigger
          id={id}
          size="sm"
          aria-label={`${name} separate item`}
          className="w-[150px] px-2 text-small"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {itemModes(module).map((m) => (
            <SelectItem key={m} value={m}>
              {itemModeLabel(module, m)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * "Separate items": the field label, a row per module and the reorder
 * footnote. `offReason` says why a module is disabled; `locked` disables all.
 */
export function MenuBarItems({
  items,
  offReason,
  locked,
}: {
  items: MenuBarSettings["items"];
  offReason: (m: SettingsModule) => ReactNode;
  locked: boolean;
}) {
  return (
    <div data-settings-row="menu-bar-items">
      <div className={cn(FIELD_LABEL, "px-4 pt-3 pb-1")}>Separate items</div>
      {SETTINGS_MODULES.map((m) => (
        <ItemRow
          key={m}
          module={m}
          mode={items[m]}
          off={offReason(m)}
          locked={locked}
        />
      ))}
      <p className="px-4 py-3 font-normal text-muted-foreground text-small">
        Each gets its own place in the menu bar, left of the bars. ⌘-drag to
        reorder.
      </p>
    </div>
  );
}
