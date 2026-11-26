/** The Appearance panel on the General tab: match the system, light or dark. */
import type { Appearance, Settings } from "@core/generated/types";
import { SegmentedControl } from "~/components/segmented-control";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { useWriteSettings } from "~/hooks/use-write-settings";

const APPEARANCES = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies readonly { value: Appearance; label: string }[];

/** "Appearance" settings panel with one row choosing the color scheme. */
export function AppearancePanel({ general }: { general: Settings["general"] }) {
  const write = useWriteSettings();
  return (
    <SettingsPanel id="appearance" title="Appearance">
      <SettingsRow id="appearance" label="Appearance">
        <SegmentedControl
          ariaLabel="Appearance"
          options={APPEARANCES}
          value={general.appearance}
          onChange={(appearance) => write({ general: { appearance } })}
        />
      </SettingsRow>
    </SettingsPanel>
  );
}
