import { Icon } from "./icons";

export function BackButton(_props: { onPress?: () => void }) {
  return <Icon name="chevron.left" accessibilityLabel="Back" />;
}

export function useAccessibilityEscape(_onEscape?: () => void): {
  onAccessibilityEscape(): void;
} {
  return { onAccessibilityEscape() {} };
}
