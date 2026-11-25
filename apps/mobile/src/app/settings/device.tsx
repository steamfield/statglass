import { ScrollView, View } from "react-native";
import { AppLockSetting } from "@/lock/app-lock-setting";
import { Text } from "@/ui/text";

/** Shows the phone's pairing state and its app lock. */
export default function DeviceSettings() {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="gap-3 px-4 pt-2 pb-safe-or-4">
        <Text role="body">Available after pairing</Text>
        <AppLockSetting />
      </View>
    </ScrollView>
  );
}
