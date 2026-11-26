import { remoteErrorText } from "@core/remote-errors";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { useDataPolicyError, useNativeHandle } from "@/transport";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { Text } from "@/ui/text";
import { SettingsScroll } from "./settings-scroll";
import { SettingsSwitchRow } from "./settings-switch-row";

const LIVE = "Live updates on cellular";

export function DataSettings() {
  const value = usePhoneSettings((settings) => settings.liveOnCellular);
  const { set } = usePhoneSettingsActions();
  const native = useNativeHandle();
  const error = useDataPolicyError(native);
  return (
    <SettingsScroll>
      <ListSection footer="When this is off, the host screen updates every 5 s on cellular.">
        <GroupedList>
          <SettingsSwitchRow
            label={LIVE}
            value={value}
            onValueChange={(liveOnCellular) => set({ liveOnCellular })}
          />
        </GroupedList>
      </ListSection>
      {error && (
        <Text variant="caption" accessibilityRole="alert" className="px-4">
          Couldn’t apply the data setting. {remoteErrorText(error)}
        </Text>
      )}
    </SettingsScroll>
  );
}
