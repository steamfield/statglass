import { commandErrorText } from "@core/command-error";
import Constants from "expo-constants";
import { useState } from "react";
import { Linking } from "react-native";
import { currentNativeBuildInfo, protocolRangeText } from "@/transport";
import { GroupedList } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { Text } from "@/ui/text";
import { SettingsScroll } from "./settings-scroll";

const LICENSE_URL = "https://github.com/steamfield/statglass/blob/main/LICENSE";

export function AboutSettings() {
  const [core] = useState(currentNativeBuildInfo);
  const [licenseError, setLicenseError] = useState<string | null>(null);

  async function openLicenses() {
    setLicenseError(null);
    try {
      await Linking.openURL(LICENSE_URL);
    } catch (error) {
      setLicenseError(commandErrorText(error, "Couldn’t open the licenses."));
    }
  }

  return (
    <SettingsScroll>
      <GroupedList>
        <ListRow
          title="App version"
          value={Constants.expoConfig?.version ?? "Unavailable"}
        />
        <ListRow title="Core" value={core?.version ?? "Unavailable"} />
        <ListRow
          title="Protocol"
          value={core ? protocolRangeText(core) : "Unavailable"}
        />
        <ListRow
          title="Licenses"
          accessory="chevron"
          onPress={() => void openLicenses()}
        />
      </GroupedList>
      {licenseError && (
        <Text variant="caption" accessibilityRole="alert" className="px-4">
          {licenseError}
        </Text>
      )}
    </SettingsScroll>
  );
}
