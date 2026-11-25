import type { ComponentRef, Ref } from "react";
import { ScrollView, type ScrollViewProps, View } from "react-native";
import { ScrollViewContainer } from "react-native-reorderable-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "./theme-colors";

export function ScreenScroll({
  headerShown = true,
  reorderable,
  onScroll,
  ref,
  style,
  ...props
}: Omit<ScrollViewProps, "onScroll"> & {
  headerShown?: boolean;
  ref?: Ref<ComponentRef<typeof ScrollView>>;
} & (
    | { reorderable: true; onScroll?: never }
    | { reorderable?: false; onScroll?: ScrollViewProps["onScroll"] }
  )) {
  const { top, bottom } = useSafeAreaInsets();
  const { background } = useThemeColors();
  const scrollProps: Omit<ScrollViewProps, "onScroll"> = {
    ...props,
    contentInsetAdjustmentBehavior: headerShown ? "automatic" : "never",
    style: [style, { backgroundColor: background }],
  };
  const scroll = reorderable ? (
    <ScrollViewContainer
      {...scrollProps}
      // The library's declaration predates React Native's ScrollView instance type.
      ref={ref as Ref<ComponentRef<typeof ScrollViewContainer>>}
    />
  ) : (
    <ScrollView {...scrollProps} onScroll={onScroll} ref={ref} />
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
