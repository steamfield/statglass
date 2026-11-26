import { useSettings } from "~/stores/settings-store";
import { CommandLinePanel } from "../command-line-panel";
import { PairedDevicesPanel } from "../paired-devices/panel";
import { RemotePanel } from "../remote-panel";

/** Access: Other Macs, iPhones, Command line. */
export function AccessTab() {
  const settings = useSettings((s) => s);
  if (!settings) return null;
  return (
    <>
      <RemotePanel enabled={settings.remote_access?.enabled ?? false} />
      <PairedDevicesPanel />
      <CommandLinePanel enabled={settings.cli_access?.enabled ?? true} />
    </>
  );
}
