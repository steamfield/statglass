import Constants from "expo-constants";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import {
  currentNativeBuildInfo,
  protocolRangeText,
} from "@/transport/build-info";
import { Text } from "@/ui/text";

/** Shows the app version and the installed core's build info. */
export default function AboutSettings() {
  const [core] = useState(currentNativeBuildInfo);
  const rows = [
    {
      label: "App version",
      value: Constants.expoConfig?.version ?? "Unavailable",
    },
    { label: "Core", value: core?.version ?? "Unavailable" },
    {
      label: "Protocol",
      value: core ? protocolRangeText(core) : "Unavailable",
    },
  ];
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="px-4 pt-2 pb-safe-or-4">
        <View className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map(({ label, value }, index) => (
            <View
              key={label}
              accessible
              accessibilityLabel={label}
              accessibilityValue={{ text: value }}
              className={`min-h-[44px] flex-row flex-wrap items-center justify-between gap-2 px-4 py-3 ${index ? "border-border-subtle border-t" : ""}`}
            >
              <Text role="body" className="shrink">
                {label}
              </Text>
              <Text role="label" className="shrink">
                {value}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
