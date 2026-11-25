/**
 * The phase 4 debug screen: connects the native core to one host with a key
 * installed by hand and shows its live CPU. Reached at `statglass://debug`.
 */
import { ScrollView, View } from "react-native";
import { Text } from "@/ui/text";

/** Host form, the phone's `authorized_keys` line, connection state and live CPU. */
export function DebugScreen() {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      <View className="px-4 pt-2">
        <Text role="body">Not built yet</Text>
      </View>
    </ScrollView>
  );
}
