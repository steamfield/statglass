import type { Settings } from "@core/generated/bindings";
import { unavailableText } from "@core/module-state";
import {
  modulePatch,
  modulePresence,
  SETTINGS_MODULES,
} from "@core/settings-patch";
import { ModuleToggleRow } from "~/components/module-toggle-list";
import { SettingsPanel } from "~/components/settings-row";
import { useHostNoun } from "~/hooks/use-host-record";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { cn } from "~/lib/utils";
import { useHost } from "~/stores/host-store";
import { FIELD_LABEL } from "~/widgets/lib/classes";
import { MODULE_META } from "~/widgets/lib/module-meta";

/**
 * "Modules": swatch, name and the On switch. A module the host lacks stays
 * listed, disabled, saying why for this host. What a module shows in the
 * menu bar is the Menu bar panel's (D-102); switching a module off keeps
 * those choices for when it comes back.
 */
export function ModulesPanel({ modules }: { modules: Settings["modules"] }) {
  const caps = useHost((s) => s.capabilities);
  const noun = useHostNoun();
  const write = useWriteSettings();

  return (
    <SettingsPanel title="Modules">
      <div className="flex min-h-[34px] items-center gap-3 border-border-subtle border-b px-4">
        <span className={cn(FIELD_LABEL, "flex-1")}>Module</span>
        <span className={cn(FIELD_LABEL, "w-[30px]")}>On</span>
      </div>
      {SETTINGS_MODULES.map((m) => (
        <ModuleToggleRow
          key={m}
          module={m}
          checked={modules[m]?.enabled ?? false}
          absence={unavailableText(
            modulePresence(caps?.modules[m], caps !== null),
            noun
          )}
          switchLabel={`${MODULE_META[m].name} enabled`}
          onCheckedChange={(enabled) => write(modulePatch(m, { enabled }))}
        />
      ))}
    </SettingsPanel>
  );
}
