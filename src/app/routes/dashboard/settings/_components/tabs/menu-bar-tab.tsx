import { useSettings } from "~/stores/settings-store";
import { MenuBarPanel } from "../menu-bar-panel";

/** Menu bar: the icon switch, preview, bars, values and separate items. */
export function MenuBarTab() {
  const settings = useSettings((s) => s);
  if (!settings) return null;
  return (
    <MenuBarPanel
      modules={settings.modules}
      menuBar={settings.menu_bar}
      general={settings.general}
    />
  );
}
