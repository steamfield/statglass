import { useEffect, useRef } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/** iOS needs an explicit VoiceOver announcement for text that changes in place. */
export function useStatusAnnouncement(
  message: string | null,
  key: string | null = message
) {
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (announced.current === key) return;
    announced.current = key;
    if (Platform.OS === "ios" && message) {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [key, message]);
}
