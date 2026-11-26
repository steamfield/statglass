import { useSettings } from "~/stores/settings-store";
import { AppearancePanel } from "../appearance-panel";
import { StartupPanel } from "../startup-panel";
import { UnitsPanel } from "../units-panel";

/** General: Startup, Appearance, Units. */
export function GeneralTab() {
  const settings = useSettings((s) => s);
  if (!settings) return null;
  return (
    <>
      <StartupPanel general={settings.general} />
      <AppearancePanel general={settings.general} />
      <UnitsPanel units={settings.units} />
    </>
  );
}
