import {
  type ModuleState,
  type UiModule,
  unavailableText,
} from "@core/module-state";
import { useHostNoun } from "~/hooks/use-host-record";
import { MODULE_META } from "~/widgets/lib/module-meta";
import { ModuleCard } from "~/widgets/module-card";

/**
 * A module the build cannot run here (plan 4.17): "Not available in this
 * edition" for an App Store build without the entitlement, otherwise "Not
 * available on this Mac". Same card shell as its live siblings, no figures.
 */
export function UnavailableCard({
  module,
  state,
  compact,
  onToggle,
}: {
  module: UiModule;
  state: ModuleState;
  compact?: boolean;
  onToggle?: (() => void) | undefined;
}) {
  const noun = useHostNoun();
  return (
    <ModuleCard
      compact={compact ?? false}
      onToggle={onToggle}
      accent={MODULE_META[module].accent}
      title={MODULE_META[module].name}
    >
      <p className="m-0 font-normal text-muted-foreground text-small">
        {unavailableText(state, noun) ?? "Not available"}
      </p>
    </ModuleCard>
  );
}
