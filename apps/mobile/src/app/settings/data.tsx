import { ScrollView, Switch, useColorScheme, View } from "react-native";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";

const CELLULAR = [
  { key: "liveOnCellular", label: "Live updates on cellular" },
  { key: "syncOnCellular", label: "Sync history on cellular" },
] as const;

/** Controls cellular use for live updates and history sync. */
export default function DataSettings() {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="px-4 pt-2 pb-safe-or-4">
        <View className="overflow-hidden rounded-xl border border-border bg-card">
          {CELLULAR.map(({ key, label }, index) => (
            <CellularSwitch
              key={key}
              setting={key}
              label={label}
              divided={index > 0}
            />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

function CellularSwitch({
  setting,
  label,
  divided,
}: {
  setting: (typeof CELLULAR)[number]["key"];
  label: string;
  divided: boolean;
}) {
  const value = usePhoneSettings((s) => s[setting]);
  const { set } = usePhoneSettingsActions();
  const colors = themeColors[useColorScheme() === "dark" ? "dark" : "light"];
  return (
    <View
      className={`min-h-[44px] flex-row items-center gap-3 px-4 py-2 ${divided ? "border-border-subtle border-t" : ""}`}
    >
      <Text role="body" className="flex-1">
        {label}
      </Text>
      <Switch
        accessibilityRole="switch"
        accessibilityLabel={label}
        value={value}
        onValueChange={(next) => set({ [setting]: next })}
        hitSlop={{ top: 7, bottom: 7, left: 0, right: 0 }}
        trackColor={{ true: colors.primary }}
      />
    </View>
  );
}
