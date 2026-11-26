import type { SettingsTabId } from "~/lib/settings-links";

/**
 * The sticky Settings tab bar under the page header, with the count of
 * device updates waiting on Access. Lane a implements it.
 */
export function SettingsTabs(_props: {
  value: SettingsTabId;
  onValueChange: (tab: SettingsTabId) => void;
}) {
  return null;
}
