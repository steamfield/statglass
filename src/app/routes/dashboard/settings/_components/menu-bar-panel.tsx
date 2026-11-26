/**
 * The Menu bar tab's panel (D-102): whether the menu-bar icon shows, a live
 * preview of it, then the three independent choices it is built from. Bars,
 * the values printed after them, and modules' separate items. Every control
 * writes a one-key patch.
 */
import type { MenuBarSettings, Settings } from "@core/generated/types";
import {
  type ModulePresence,
  modulePresence,
  unavailableText,
} from "@core/module-state";
import { menuBarOf, type SettingsModule } from "@core/settings-patch";
import {
  combinedWidthPt,
  type TrayLayout,
  trayLayout,
  WIDE_ITEM_PT,
} from "@core/tray-layout";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Switch } from "~/components/ui/switch";
import { useHostNoun } from "~/hooks/use-host-record";
import { useTrayReadings, useTrayUnits } from "~/hooks/use-tray-readings";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { useHost } from "~/stores/host-store";
import { MODULE_META } from "~/widgets/lib/module-meta";
import { TrayPreview } from "~/widgets/tray-preview";
import { MenuBarBars } from "./menu-bar-bars";
import { MenuBarItems } from "./menu-bar-items";
import { MenuBarValues } from "./menu-bar-values";

/** Why a module's controls are disabled, or null when they are not. */
function offText(
  m: SettingsModule,
  presence: ModulePresence,
  enabled: boolean,
  noun: "Mac" | "host"
) {
  const absence = unavailableText(presence, noun);
  if (absence !== null) return absence;
  if (!enabled)
    return `Turn on ${MODULE_META[m].name} in Monitoring to use this`;
  return null;
}

/** Show menu-bar icon, and while it is off, why the rest is locked. */
function ShowIconRow({ shown }: { shown: boolean }) {
  const write = useWriteSettings();
  return (
    <>
      <SettingsRow
        id="show-menu-bar-icon"
        label="Show menu-bar icon"
        sub="Open StatGlass from Finder to show its dashboard when hidden."
      >
        <Switch
          checked={shown}
          aria-label="Show menu-bar icon"
          onCheckedChange={(on) => write({ general: { show_menu_bar: on } })}
        />
      </SettingsRow>
      {!shown && (
        <p className="border-border-subtle border-b px-4 py-2 font-normal text-muted-foreground text-small">
          Turn on Show menu-bar icon to change what it shows.
        </p>
      )}
    </>
  );
}

/**
 * The menu bar as it would look now, stuck under the Settings header
 * (`--settings-sticky-top`, set by the route) while the choices scroll.
 */
function MenuBarPreview({ layout }: { layout: TrayLayout }) {
  const wide = combinedWidthPt(layout.combined) > WIDE_ITEM_PT;
  return (
    <div
      data-testid="menu-bar-preview"
      className="sticky top-[var(--settings-sticky-top,0px)] z-10 flex flex-col gap-2 border-border-subtle border-b bg-card px-4 py-3"
    >
      <TrayPreview layout={layout} />
      {wide && (
        <span className="font-normal text-muted-foreground text-small">
          Wide items can end up hidden behind the camera on MacBooks with a
          notch.
        </span>
      )}
    </div>
  );
}

/**
 * "Menu bar": the icon switch, the preview, then bars, values and separate
 * items. While the icon is hidden those choices are kept but locked.
 */
export function MenuBarPanel({
  modules,
  menuBar: stored,
  general,
}: {
  modules: Settings["modules"];
  menuBar: MenuBarSettings | undefined;
  general: Settings["general"];
}) {
  const menuBar = menuBarOf({ menu_bar: stored });
  const caps = useHost((s) => s.capabilities);
  const readings = useTrayReadings();
  const units = useTrayUnits();
  const noun = useHostNoun();
  const iconShown = general.show_menu_bar ?? true;
  const locked = !iconShown;

  const presence = (m: SettingsModule) =>
    modulePresence(caps?.modules[m], caps !== null);
  const enabled = (m: SettingsModule) =>
    presence(m) === "present" && (modules[m]?.enabled ?? false);
  const moduleOffText = (m: SettingsModule) =>
    offText(m, presence(m), enabled(m), noun);

  return (
    <SettingsPanel id="menu-bar" title="Menu bar" overflow="visible">
      <ShowIconRow shown={iconShown} />
      <MenuBarPreview layout={trayLayout(menuBar, enabled, readings, units)} />
      <MenuBarBars bars={menuBar.bars} enabled={enabled} locked={locked} />
      <MenuBarValues
        readouts={menuBar.readouts}
        offText={moduleOffText}
        locked={locked}
        readings={readings}
        units={units}
      />
      <MenuBarItems
        items={menuBar.items}
        offText={moduleOffText}
        locked={locked}
      />
    </SettingsPanel>
  );
}
