import { useRouter } from "expo-router";
import type { ScrollViewProps } from "react-native";
import { View } from "react-native";
import { useAccessibilityEscape } from "@/ui/back-button";
import { ScreenScroll } from "@/ui/screen-scroll";

export function useSettingsEscape() {
  const router = useRouter();
  return useAccessibilityEscape(() => {
    if (router.canGoBack()) router.back();
  });
}

export function SettingsScroll({ children, ...props }: ScrollViewProps) {
  const escapeProps = useSettingsEscape();
  return (
    <ScreenScroll className="flex-1" {...escapeProps} {...props}>
      <View className="gap-3 px-4 pt-2 pb-safe-or-4">{children}</View>
    </ScreenScroll>
  );
}
