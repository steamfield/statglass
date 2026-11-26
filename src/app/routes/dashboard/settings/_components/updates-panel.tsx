/**
 * The Updates panel on the About tab: the running version and the two
 * automatic-update switches.
 */
import type { Settings } from "@core/generated/types";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Switch } from "~/components/ui/switch";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { UpdateRow } from "./update-row";

const INSTALL_NEEDS_CHECKING = "Needs Check for updates automatically.";
const INSTALL_RESTART_NOTE =
  "StatGlass restarts when the dashboard and popover are closed and no changes are in progress.";

/** "Updates" settings panel: version, automatic checks and automatic installs. */
export function UpdatesPanel({ general }: { general: Settings["general"] }) {
  const write = useWriteSettings();
  return (
    <SettingsPanel id="updates" title="Updates">
      <UpdateRow />
      <SettingsRow id="check-updates" label="Check for updates automatically">
        <Switch
          checked={general.check_updates}
          aria-label="Check for updates automatically"
          onCheckedChange={(on) => write({ general: { check_updates: on } })}
        />
      </SettingsRow>
      <SettingsRow
        id="install-updates"
        nested
        label="Install updates automatically"
        sub={
          general.check_updates ? INSTALL_RESTART_NOTE : INSTALL_NEEDS_CHECKING
        }
      >
        <Switch
          checked={general.auto_install_updates ?? true}
          disabled={!general.check_updates}
          aria-label="Install updates automatically"
          onCheckedChange={(on) =>
            write({ general: { auto_install_updates: on } })
          }
        />
      </SettingsRow>
    </SettingsPanel>
  );
}
