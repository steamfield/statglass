/**
 * The Menu bar panel's Bars block: which of CPU, GPU and Memory draw a bar,
 * and which of them need their module turned on first.
 */
import type { MenuBarSettings } from "@core/generated/types";
import { barPatch } from "@core/settings-patch";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { MODULE_META } from "~/widgets/lib/module-meta";

// The modules that can draw a bar in the menu bar.
const BAR_MODULES = ["cpu", "gpu", "memory"] as const;

type BarModule = (typeof BAR_MODULES)[number];

/** "Turn on GPU and Memory in Monitoring to show their bars." */
function barsOffText(off: readonly BarModule[]): string {
  const names = off.map((m) => MODULE_META[m].name);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Turn on ${list} in Monitoring to show ${names.length === 1 ? "its bar" : "their bars"}`;
}

/**
 * The bars toggle group; a module that is off can't be picked, and every
 * toggle is disabled while `locked` (the menu-bar icon is hidden).
 */
export function MenuBarBars({
  bars,
  enabled,
  locked,
}: {
  bars: MenuBarSettings["bars"];
  enabled: (m: BarModule) => boolean;
  locked: boolean;
}) {
  const write = useWriteSettings();
  const barsOn = BAR_MODULES.filter((m) => enabled(m) && bars[m]);
  const barsOff = BAR_MODULES.filter((m) => !enabled(m));

  return (
    <div
      data-settings-row="menu-bar-bars"
      className="flex min-h-12 flex-wrap items-center gap-3 border-border-subtle border-b px-4 text-body"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-2">
        <span>Bars</span>
        {barsOff.length > 0 && (
          <span className="font-normal text-muted-foreground text-small">
            {barsOffText(barsOff)}
          </span>
        )}
      </div>
      <ToggleGroup
        type="multiple"
        size="sm"
        aria-label="Bars in the menu bar"
        value={[...barsOn]}
        onValueChange={(next) => {
          for (const m of BAR_MODULES) {
            const on = next.includes(m);
            if (on !== barsOn.includes(m)) write(barPatch(m, on));
          }
        }}
      >
        {BAR_MODULES.map((m) => (
          <ToggleGroupItem
            key={m}
            value={m}
            disabled={locked || !enabled(m)}
            className="px-2.5"
          >
            {MODULE_META[m].name}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
