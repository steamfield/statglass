import { router } from "expo-router";
import { HeaderButton } from "./header-button";

function goBack() {
  router.back();
}

export function BackButton({ onPress = goBack }: { onPress?: () => void }) {
  return (
    <HeaderButton
      icon="chevron.left"
      accessibilityLabel="Back"
      onPress={onPress}
    />
  );
}

export function useAccessibilityEscape(onEscape = goBack): {
  onAccessibilityEscape(): void;
} {
  return { onAccessibilityEscape: onEscape };
}
