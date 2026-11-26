import { useSettings } from "~/stores/settings-store";
import { ModulesPanel } from "../modules-panel";
import { SamplingPanel } from "../sampling-panel";

/** Monitoring: Modules, Sampling. */
export function MonitoringTab() {
  const settings = useSettings((s) => s);
  if (!settings) return null;
  return (
    <>
      <ModulesPanel modules={settings.modules} />
      {/* Lane c moves the history rows to the History tab and drops `history`. */}
      <SamplingPanel sampling={settings.sampling} history={settings.history} />
    </>
  );
}
