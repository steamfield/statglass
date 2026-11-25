import * as LocalAuthentication from "expo-local-authentication";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { SettingsSwitchRow } from "@/settings/settings-switch-row";
import { setNativeSnapshotCover } from "@/transport";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { Text } from "@/ui/text";

/** Enables app lock only after iOS has authenticated the device owner. */
export function AppLockSetting() {
  const enabled = usePhoneSettings((s) => s.appLock);
  const { set } = usePhoneSettingsActions();
  const [level, setLevel] = useState<LocalAuthentication.SecurityLevel | null>(
    null
  );
  const [enrollmentError, setEnrollmentError] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function readEnrollment() {
      try {
        const result = await LocalAuthentication.getEnrolledLevelAsync();
        if (ignore) return;
        setLevel(result);
        setEnrollmentError(false);
      } catch (error) {
        if (ignore) return;
        console.warn("Could not check app lock enrollment", error);
        setLevel(null);
        setEnrollmentError(true);
      }
    }
    void readEnrollment();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void readEnrollment();
    });
    return () => {
      ignore = true;
      listener.remove();
    };
  }, []);

  async function change(next: boolean) {
    setPromptError(null);
    if (!next) {
      set({ appLock: false });
      return;
    }
    setPrompting(true);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Turn on App Lock",
      });
      if (result.success) {
        // Arm the cover before publishing the setting so UIKit can act on it immediately.
        setNativeSnapshotCover(true);
        set({ appLock: true });
      } else if (result.error !== "user_cancel")
        setPromptError("iOS couldn’t verify your identity. Try again.");
    } catch (error) {
      console.warn("Could not authenticate to enable app lock", error);
      setPromptError("iOS couldn’t open the verification prompt. Try again.");
    } finally {
      setPrompting(false);
    }
  }

  const unenrolled = level === LocalAuthentication.SecurityLevel.NONE;
  const disabled = prompting || (!enabled && (level === null || unenrolled));
  return (
    <ListSection>
      <GroupedList>
        <SettingsSwitchRow
          label="App Lock"
          disabled={disabled}
          value={enabled}
          onValueChange={change}
        />
      </GroupedList>
      {unenrolled && (
        <Text variant="caption" className="px-4">
          Set up Face ID or a passcode on this iPhone to use App Lock.
        </Text>
      )}
      {enrollmentError && (
        <Text variant="label" accessibilityRole="alert" className="px-4">
          Couldn’t check Face ID or passcode settings.
        </Text>
      )}
      {promptError && (
        <Text variant="label" accessibilityRole="alert" className="px-4">
          {promptError}
        </Text>
      )}
    </ListSection>
  );
}
