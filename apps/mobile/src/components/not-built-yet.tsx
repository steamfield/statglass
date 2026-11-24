/**
 * Body of a route whose screen does not exist yet. The pairing and demo
 * routes render it until their real screens land.
 */
import { Text, View } from "react-native";

/** Placeholder body saying the screen is not built yet. */
export function NotBuiltYet() {
  return (
    <View className="flex-1 items-center justify-center bg-background p-6">
      <Text className="text-base text-muted-foreground">Not built yet</Text>
    </View>
  );
}
