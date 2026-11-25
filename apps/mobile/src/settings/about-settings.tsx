import { commandErrorText } from "@core/command-error";
import Constants from "expo-constants";
import { useRef, useState } from "react";
import { AccessibilityInfo, Linking } from "react-native";
import { PRIVACY_POLICY_URL, SUPPORT_URL } from "@/lib/links";
import { currentNativeBuildInfo, protocolRangeText } from "@/transport";
import { GroupedList } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { Text } from "@/ui/text";
import { SettingsScroll } from "./settings-scroll";

const LICENSE_URL = "https://github.com/steamfield/statglass/blob/main/LICENSE";
const PAGE_OPEN_ERROR = "Couldn't open the page";

export function AboutSettings() {
  const config = Constants.expoConfig;
  const version = config?.version;
  const build = config?.ios?.buildNumber;
  const appVersion = version && build ? `${version} (${build})` : version;
  const [core] = useState(currentNativeBuildInfo);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const pageRequest = useRef(0);

  async function openPage(url: string) {
    const request = ++pageRequest.current;
    setFailedUrl(null);
    try {
      await Linking.openURL(url);
    } catch (error: unknown) {
      console.warn("[about] Could not open page", { url, error });
      if (request !== pageRequest.current) return;
      setFailedUrl(url);
      AccessibilityInfo.announceForAccessibility(PAGE_OPEN_ERROR);
    }
  }

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
        <ListRow title="App version" value={appVersion ?? "Unavailable"} />
        <ListRow title="Core" value={core?.version ?? "Unavailable"} />
        <ListRow
          title="Protocol"
          value={core ? protocolRangeText(core) : "Unavailable"}
        />
        <ListRow
          title="Privacy policy"
          accessory="chevron"
          accessibilityRole="link"
          onPress={() => void openPage(PRIVACY_POLICY_URL)}
        />
        <ListRow
          title="Support"
          accessory="chevron"
          accessibilityRole="link"
          onPress={() => void openPage(SUPPORT_URL)}
        />
        <ListRow
          title="Licenses"
          accessory="chevron"
          onPress={() => void openLicenses()}
        />
      </GroupedList>
      {failedUrl && (
        <Text
          variant="caption"
          accessibilityRole="alert"
          className="px-4"
          selectable
        >
          {`${PAGE_OPEN_ERROR}\n${failedUrl}`}
        </Text>
      )}
      {licenseError && (
        <Text variant="caption" accessibilityRole="alert" className="px-4">
          {licenseError}
        </Text>
      )}
    </SettingsScroll>
  );
}
