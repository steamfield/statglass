import { Stack } from "expo-router";
import { ScrollView, View } from "react-native";
import { Text } from "@/ui/text";

export default function UpdateFromMac() {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: "Update from Mac" }} />
      <View className="gap-2 px-6 pt-4 pb-safe-or-6">
        <Text role="title">Not built yet</Text>
        <Text role="body">
          Show a fresh QR code on the Mac to offer new hosts and mark removed
          ones on this iPhone.
        </Text>
      </View>
    </ScrollView>
  );
}
