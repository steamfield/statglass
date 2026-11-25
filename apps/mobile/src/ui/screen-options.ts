import type { NativeStackNavigationOptions } from "expo-router";
import { createElement } from "react";
import { PixelRatio } from "react-native";
import { BackButton } from "./back-button";
import type { ThemeColors } from "./theme-colors";

function renderBack({ canGoBack }: { canGoBack?: boolean }) {
  return canGoBack ? createElement(BackButton) : null;
}

export function screenOptions(
  colors: ThemeColors,
  {
    largeTitle = false,
    root = false,
  }: { largeTitle?: boolean; root?: boolean } = {}
): NativeStackNavigationOptions {
  const titleStyle = { color: colors.foreground, fontWeight: "600" } as const;
  // UIKit caps large-title scaling at XXXL.
  const largeTitleScale = Math.min(PixelRatio.getFontScale(), 1.235);
  return {
    headerTransparent: true,
    headerBlurEffect: "systemChromeMaterial",
    headerLargeTitle: largeTitle,
    headerLargeTitleShadowVisible: false,
    headerTitleStyle: { ...titleStyle, fontSize: 17 },
    headerLargeTitleStyle: { ...titleStyle, fontSize: 34 * largeTitleScale },
    headerBackVisible: false,
    ...(!root && {
      headerLeft: renderBack,
      // On iOS, headerLeft alone wraps the custom view in a glass button.
      unstable_headerLeftItems: (props) => {
        const element = renderBack(props);
        return element
          ? [{ type: "custom", element, hidesSharedBackground: true }]
          : [];
      },
    }),
    gestureEnabled: true,
    fullScreenGestureEnabled: false,
    // The stack already provides the top blur through headerBlurEffect.
    scrollEdgeEffects: { top: "hidden" },
  };
}
