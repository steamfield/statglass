import { Pressable, ScrollView, View } from "react-native";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { Text } from "@/ui/text";

const CHOICES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** Sets the phone's color scheme or follows iOS. */
export default function AppearanceSettings() {
  const appearance = usePhoneSettings((s) => s.appearance);
  const { set } = usePhoneSettingsActions();

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="px-4 pt-2 pb-safe-or-4">
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Color scheme"
          className="overflow-hidden rounded-xl border border-border bg-card"
        >
          {CHOICES.map(({ value, label }, index) => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityState={{ checked: appearance === value }}
              onPress={() => set({ appearance: value })}
              className={`min-h-[44px] flex-row items-center justify-between gap-3 px-4 py-2 active:bg-secondary ${index ? "border-border-subtle border-t" : ""}`}
            >
              <Text variant="body" className="shrink">
                {label}
              </Text>
              {appearance === value && (
                <Text variant="body" className="text-link" accessible={false}>
                  ✓
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
