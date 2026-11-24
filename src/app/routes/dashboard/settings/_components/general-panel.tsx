import type { Appearance, Settings } from "@core/generated/types";
import {
  formatSystemDiagnostics,
  GITHUB_ISSUES_URL,
  GITHUB_REPO_URL,
} from "@core/star-prompt";
import { toast } from "sonner";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { useHostRecord } from "~/hooks/use-host-record";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { openExternalUrl, recordStarPromptAction } from "~/lib/github-links";
import { useTransport } from "~/lib/transport-context";
import { version } from "../../../../../../package.json";
import { UpdateRow } from "./update-row";

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

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

/** "General" settings panel: startup, appearance, updates, feedback, and support. */
export function GeneralPanel({ general }: { general: Settings["general"] }) {
  const write = useWriteSettings();

  return (
    <SettingsPanel title="General">
      <SettingsRow label="Launch at login">
        <Switch
          checked={general.launch_at_login}
          aria-label="Launch at login"
          onCheckedChange={(on) => write({ general: { launch_at_login: on } })}
        />
      </SettingsRow>
      <SettingsRow
        label="Show menu-bar icon"
        sub="Open StatGlass from Finder to show its dashboard when hidden."
      >
        <Switch
          checked={general.show_menu_bar ?? true}
          aria-label="Show menu-bar icon"
          onCheckedChange={(on) => write({ general: { show_menu_bar: on } })}
        />
      </SettingsRow>
      <SettingsRow label="Show in Dock">
        <Switch
          checked={general.show_in_dock}
          aria-label="Show in Dock"
          onCheckedChange={(on) => write({ general: { show_in_dock: on } })}
        />
      </SettingsRow>
      <SettingsRow label="Appearance" htmlFor="settings-appearance">
        <Select
          value={general.appearance}
          onValueChange={(v) =>
            write({ general: { appearance: v as Appearance } })
          }
        >
          <SelectTrigger
            id="settings-appearance"
            size="sm"
            className="px-2 text-small"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APPEARANCES.map((a) => (
              <SelectItem key={a.value} value={a.value}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label="Check for updates automatically">
        <Switch
          checked={general.check_updates}
          aria-label="Check for updates automatically"
          onCheckedChange={(on) => write({ general: { check_updates: on } })}
        />
      </SettingsRow>
      <SettingsRow
        label="Install updates automatically"
        sub="StatGlass restarts when the dashboard and popover are closed and no changes are in progress."
      >
        <Switch
          checked={general.auto_install_updates ?? true}
          disabled={!general.check_updates}
          aria-label="Install updates automatically"
          onCheckedChange={(on) =>
            write({ general: { auto_install_updates: on } })
          }
        />
      </SettingsRow>
      <UpdateRow />
      <CommunityRows />
    </SettingsPanel>
  );
}
