/** The Other Macs panel on the Access tab: the remote monitoring switch. */
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Switch } from "~/components/ui/switch";
import { useWriteSettings } from "~/hooks/use-write-settings";

/** "Other Macs" settings panel: whether other Macs and iPhones may view this one. */
export function RemotePanel({ enabled }: { enabled: boolean }) {
  const write = useWriteSettings();
  return (
    <SettingsPanel id="remote" title="Other Macs">
      <SettingsRow
        id="remote-monitoring"
        label="Allow remote monitoring"
        sub="Other Macs signed in over SSH as your user and iPhones you've paired can view this Mac while StatGlass is running."
      >
        <Switch
          aria-label="Allow remote monitoring"
          checked={enabled}
          onCheckedChange={(next) =>
            write({ remote_access: { enabled: next } })
          }
        />
      </SettingsRow>
    </SettingsPanel>
  );
}
