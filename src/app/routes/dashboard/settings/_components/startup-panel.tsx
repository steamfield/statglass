/**
 * The Startup panel on the General tab: whether StatGlass opens at login and
 * whether it shows in the Dock.
 */
import type { Settings } from "@core/generated/types";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Switch } from "~/components/ui/switch";
import { useWriteSettings } from "~/hooks/use-write-settings";

/** "Startup" settings panel: Launch at login and Show in Dock. */
export function StartupPanel({ general }: { general: Settings["general"] }) {
  const write = useWriteSettings();
  return (
    <SettingsPanel id="startup" title="Startup">
      <SettingsRow id="launch-at-login" label="Launch at login">
        <Switch
          checked={general.launch_at_login}
          aria-label="Launch at login"
          onCheckedChange={(on) => write({ general: { launch_at_login: on } })}
        />
      </SettingsRow>
      <SettingsRow id="show-in-dock" label="Show in Dock">
        <Switch
          checked={general.show_in_dock}
          aria-label="Show in Dock"
          onCheckedChange={(on) => write({ general: { show_in_dock: on } })}
        />
      </SettingsRow>
    </SettingsPanel>
  );
}
