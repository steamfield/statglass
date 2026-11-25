import { useNavigation } from "expo-router";
import { useEffect } from "react";
import { useNativeCoreStarting } from "@/transport";

/** Opens the root index when a host route has no chosen transport. */
export function FirstLaunchRedirect() {
  const root = useNavigation("/");
  const starting = useNativeCoreStarting();
  useEffect(() => {
    if (starting) return;
    const target = root.getState()?.key;
    if (!target) return;
    // Both index routes have pathname `/`. Target the root route by name.
    root.dispatch({
      type: "REPLACE",
      payload: { name: "index" },
      target,
    });
  }, [root, starting]);
  return null;
}
