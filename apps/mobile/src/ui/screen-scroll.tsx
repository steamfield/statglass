import { ScrollView, type ScrollViewProps, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "./theme-colors";

export function ScreenScroll({
  headerShown = true,
  style,
  ...props
}: ScrollViewProps & { headerShown?: boolean }) {
  const { top, bottom } = useSafeAreaInsets();
  const { background } = useThemeColors();
  const scroll = (
    <ScrollView
      {...props}
      contentInsetAdjustmentBehavior={headerShown ? "automatic" : "never"}
      style={[style, { backgroundColor: background }]}
    />
  );

  if (headerShown) return scroll;

  return (
    <View
      className="flex-1"
      // Clip the padded viewport when automatic UIKit insets are off.
      style={{
        backgroundColor: background,
        paddingTop: top,
        paddingBottom: bottom,
        overflow: "hidden",
      }}
    >
      {scroll}
    </View>
  );
}
