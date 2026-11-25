import Constants from "expo-constants";
import { ScrollView, View } from "react-native";
import { Text } from "@/ui/text";

/** Shows the app version from its Expo config. */
export default function AboutSettings() {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="px-4 pt-2 pb-safe-or-4">
        <View className="flex-row flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3">
          <Text role="body">App version</Text>
          <Text role="label">
            {Constants.expoConfig?.version ?? "Unavailable"}
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
