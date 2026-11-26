import { useSettings } from "~/stores/settings-store";
import { FeedbackPanel } from "../feedback-panel";
import { UpdatesPanel } from "../updates-panel";

/** About: Updates, Feedback. */
export function AboutTab() {
  const settings = useSettings((s) => s);
  if (!settings) return null;
  return (
    <>
      <UpdatesPanel general={settings.general} />
      <FeedbackPanel />
    </>
  );
}
