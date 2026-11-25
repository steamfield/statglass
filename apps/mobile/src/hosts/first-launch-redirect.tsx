import { useNavigation } from "expo-router";
import { useEffect } from "react";

/** Opens the root index when a host route has no chosen transport. */
export function FirstLaunchRedirect() {
  const root = useNavigation("/");
  useEffect(() => {
    const target = root.getState()?.key;
    if (!target) return;
    // Both index routes have pathname `/`. Target the root route by name.
    root.dispatch({
      type: "REPLACE",
      payload: { name: "index" },
      target,
    });
  }, [root]);
  return null;
}
