import { useSettings } from "~/stores/settings-store";
import { ClearHistoryPanel } from "../clear-history-panel";
import { HistoryPanel } from "../history-panel";

/** History: retention and size, then Clear history at the bottom. */
export function HistoryTab() {
  const settings = useSettings((s) => s);
  if (!settings) return null;
  return (
    <>
      <HistoryPanel history={settings.history} />
      <ClearHistoryPanel />
    </>
  );
}
