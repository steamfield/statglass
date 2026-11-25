import type { NativeStackNavigationOptions } from "expo-router";
import { createElement } from "react";
import { PixelRatio } from "react-native";
import { themeColors } from "@/theme.generated";
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
    // On iOS 27 the blur covers an expanded title. Keep the scroll-edge
    // appearance clear while the compact bar retains systemChromeMaterial.
    ...(largeTitle && { headerLargeStyle: { backgroundColor: "transparent" } }),
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
    // The plist makes status bar appearance view-controller based, so each
    // screen sets it; expo-status-bar's <StatusBar> has no effect.
    statusBarStyle: colors === themeColors.dark ? "light" : "dark",
    gestureEnabled: true,
    fullScreenGestureEnabled: false,
    // The stack already provides the top blur through headerBlurEffect.
    scrollEdgeEffects: { top: "hidden" },
  };
}
