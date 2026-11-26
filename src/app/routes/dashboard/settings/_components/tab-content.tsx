import type { SettingsTabId } from "~/lib/settings-links";
import { AboutTab } from "./tabs/about-tab";
import { AccessTab } from "./tabs/access-tab";
import { GeneralTab } from "./tabs/general-tab";
import { HistoryTab } from "./tabs/history-tab";
import { MenuBarTab } from "./tabs/menu-bar-tab";
import { MonitoringTab } from "./tabs/monitoring-tab";

const TABS = {
  general: GeneralTab,
  "menu-bar": MenuBarTab,
  monitoring: MonitoringTab,
  history: HistoryTab,
  access: AccessTab,
  about: AboutTab,
} satisfies Record<SettingsTabId, () => React.ReactNode>;

/** The panels of one Settings tab. */
export function TabContent({ tab }: { tab: SettingsTabId }) {
  const Tab = TABS[tab];
  return <Tab />;
}
