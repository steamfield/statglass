/** The Feedback panel on the About tab: report an issue, star the project. */
import {
  formatSystemDiagnostics,
  GITHUB_ISSUES_URL,
  GITHUB_REPO_URL,
} from "@core/star-prompt";
import { toast } from "sonner";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { useHostRecord } from "~/hooks/use-host-record";
import { openExternalUrl, recordStarPromptAction } from "~/lib/github-links";
import { useTransport } from "~/lib/transport-context";
import { version } from "../../../../../../package.json";

function CommunityRows() {
  const transport = useTransport();
  const host = useHostRecord();
  const clipboard = useCopyToClipboard("settings-diagnostics");

  const copyDiagnostics = async () => {
    const info = formatSystemDiagnostics({
      appVersion: version,
      osVersion: host?.info.os_version,
      chip: host?.info.chip,
      model: host?.info.model,
    });
    toast(
      (await clipboard.copy(info))
        ? "System info copied"
        : "Couldn't copy system info."
    );
  };

  const openFeedback = () =>
    openExternalUrl(transport, GITHUB_ISSUES_URL, "settings");

  const openStar = () => {
    openExternalUrl(transport, GITHUB_REPO_URL, "settings");
    recordStarPromptAction(transport, "starred", "settings");
  };

  return (
    <>
      <SettingsRow
        id="feedback"
        label="Feedback & issues"
        sub="Have an issue or want a feature? Copy non-personal system info or open GitHub Issues."
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copyDiagnostics}
        >
          Copy system info
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openFeedback}
        >
          File feedback
        </Button>
      </SettingsRow>
      <SettingsRow
        id="support"
        label="Support StatGlass"
        sub="StatGlass is free and open source. A star on GitHub helps others discover it."
      >
        <Button type="button" variant="outline" size="sm" onClick={openStar}>
          Star on GitHub
        </Button>
      </SettingsRow>
    </>
  );
}

/** "Feedback" settings panel: the feedback and support rows. */
export function FeedbackPanel() {
  return (
    <SettingsPanel id="feedback" title="Feedback">
      <CommunityRows />
    </SettingsPanel>
  );
}
