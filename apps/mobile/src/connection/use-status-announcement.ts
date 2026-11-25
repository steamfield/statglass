import { useEffect } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/** iOS needs an explicit VoiceOver announcement for text that changes in place. */
export function useStatusAnnouncement(message: string | null) {
  useEffect(() => {
    if (Platform.OS === "ios" && message) {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);
}
