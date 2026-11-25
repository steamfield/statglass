import { useNavigation } from "expo-router";
import { useCallback, useEffect } from "react";
import { useNativeCoreStarting } from "@/transport";

export function useReplaceWithWelcome() {
  const root = useNavigation("/");
  return useCallback(() => {
    const target = root.getState()?.key;
    if (!target) return;
    // Both index routes have pathname `/`. Target the root route by name.
    root.dispatch({
      type: "REPLACE",
      payload: { name: "index" },
      target,
    });
  }, [root]);
}

/** Opens the root index when a host route has no chosen transport. */
export function FirstLaunchRedirect() {
  const replace = useReplaceWithWelcome();
  const starting = useNativeCoreStarting();
  useEffect(() => {
    if (!starting) replace();
  }, [replace, starting]);
  return null;
}
