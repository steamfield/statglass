import type { SymbolViewProps } from "expo-symbols";
import { View } from "react-native";

// Jest has no SF Symbols renderer. Expose the name and drawing props supplied
// at Expo's native boundary so tests can check what iOS is asked to render.
export function SymbolView({
  name,
  size,
  tintColor,
  accessibilityLabel,
  accessibilityRole,
  accessible,
}: SymbolViewProps) {
  const style = { width: size, height: size, tintColor };
  return (
    <View
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      testID={typeof name === "string" ? name : name.ios}
      style={style}
    />
  );
}
