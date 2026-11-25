import { ScrollView, Switch, useColorScheme, View } from "react-native";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";

/** Controls cellular use for live updates. */
export default function DataSettings() {
  const value = usePhoneSettings((settings) => settings.liveOnCellular);
  const { set } = usePhoneSettingsActions();
  const colors = themeColors[useColorScheme() === "dark" ? "dark" : "light"];
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="gap-2 px-4 pt-2 pb-safe-or-4">
        <View className="min-h-[44px] flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-2">
          <Text role="body" className="flex-1">
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
        <Text role="caption" className="px-4">
          When this is off, the host screen updates every 5 seconds on cellular.
        </Text>
      </View>
    </ScrollView>
  );
}
