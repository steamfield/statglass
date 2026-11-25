import * as LocalAuthentication from "expo-local-authentication";
import { useEffect, useState } from "react";
import { AppState, Switch, useColorScheme, View } from "react-native";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { themeColors } from "@/theme.generated";
import { setNativeSnapshotCover } from "@/transport";
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
  const colors = themeColors[useColorScheme() === "dark" ? "dark" : "light"];

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
    <View className="gap-1 rounded-xl border border-border bg-card px-4 py-2">
      <View className="min-h-[44px] flex-row items-center gap-3">
        <Text variant="body" className="flex-1">
          App Lock
        </Text>
        <Switch
          accessibilityRole="switch"
          accessibilityLabel="App Lock"
          accessibilityState={{ disabled }}
          disabled={disabled}
          value={enabled}
          onValueChange={change}
          hitSlop={{ top: 7, bottom: 7, left: 0, right: 0 }}
          trackColor={{ true: colors.primary }}
        />
      </View>
      {unenrolled && (
        <Text variant="label" className="pb-2">
          Set up Face ID or a passcode on this iPhone to use App Lock.
        </Text>
      )}
      {enrollmentError && (
        <Text
          variant="label"
          accessibilityRole="alert"
          className="pb-2 text-destructive!"
        >
          Couldn’t check Face ID or passcode settings.
        </Text>
      )}
      {promptError && (
        <Text
          variant="label"
          accessibilityRole="alert"
          className="pb-2 text-destructive!"
        >
          {promptError}
        </Text>
      )}
    </View>
  );
}
