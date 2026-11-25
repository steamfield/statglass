import { ActionSheetIOS, Pressable, View } from "react-native";
import { Text } from "./text";
import { useThemeColors } from "./theme-colors";

export function DemoBadge({ onExit }: { onExit(): void }) {
  const { border } = useThemeColors();
  function showOptions() {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Exit demo", "Cancel"],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      (index) => {
        if (index === 0) onExit();
      }
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Demo"
      accessibilityHint="Shows the option to exit demo mode"
      className="items-center justify-center"
      // Keep the hit target at 44 pt regardless of the CSS rem size.
      style={{ minHeight: 44, minWidth: 44 }}
      onPress={showOptions}
    >
      <View
        className="rounded-full border px-3 py-1"
        style={{ borderColor: border }}
      >
        <Text variant="label">Demo</Text>
      </View>
    </Pressable>
  );
}
