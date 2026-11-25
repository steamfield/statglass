import { remoteErrorText } from "@core/remote-errors";
import { ScrollView, Switch, useColorScheme, View } from "react-native";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { themeColors } from "@/theme.generated";
import {
  isNativeTransport,
  useDataPolicyError,
  useNativeCore,
} from "@/transport";
import { Text } from "@/ui/text";

/** Controls cellular use for live updates. */
export default function DataSettings() {
  const value = usePhoneSettings((settings) => settings.liveOnCellular);
  const { set } = usePhoneSettingsActions();
  const colors = themeColors[useColorScheme() === "dark" ? "dark" : "light"];
  const transport = useOptionalPhoneTransport();
  const { core } = useNativeCore();
  const error = useDataPolicyError(
    core ?? (isNativeTransport(transport) ? transport : null)
  );
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="gap-2 px-4 pt-2 pb-safe-or-4">
        <View className="min-h-[44px] flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-2">
          <Text variant="body" className="flex-1">
            Live updates on cellular
          </Text>
          <Switch
            accessibilityRole="switch"
            accessibilityLabel="Live updates on cellular"
            value={value}
            onValueChange={(liveOnCellular) => set({ liveOnCellular })}
            hitSlop={{ top: 7, bottom: 7, left: 0, right: 0 }}
            trackColor={{ true: colors.primary }}
          />
        </View>
        <Text variant="caption" className="px-4">
          When this is off, the host screen updates every 5 seconds on cellular.
        </Text>
        {error && (
          <Text
            variant="caption"
            accessibilityRole="alert"
            className="px-4 text-destructive!"
          >
            Couldn’t apply the data setting. {remoteErrorText(error)}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}
