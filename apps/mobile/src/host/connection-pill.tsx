import type { HostId } from "@core/generated/types";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { type useConnection, useLastFrame } from "@/data/live";
import { Text } from "@/ui/text";

function useFrameAge(lastFrame: number | null) {
  const [now, setNow] = useState(() => performance.now());
  const live = lastFrame !== null;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return `${Math.max(1, Math.floor((now - (lastFrame ?? now)) / 1000))}s`;
}

/** Show the connection and announce outages. Frame updates stop at this component. */
export function ConnectionPill({
  host,
  connection,
  active,
}: {
  host: HostId;
  connection: ReturnType<typeof useConnection>;
  active: boolean;
}) {
  const { label, state } = connection;
  const lastFrame = useLastFrame(host);
  const live = state === "live" && lastFrame !== null;
  const age = useFrameAge(live && active ? lastFrame : null);
  useEffect(() => {
    if (
      active &&
      Platform.OS === "ios" &&
      (state === "offline" || state === "reconnecting")
    ) {
      AccessibilityInfo.announceForAccessibility(label);
    }
  }, [active, label, state]);

  return (
    <View className="flex-row items-center gap-2 self-start rounded-full border border-border bg-card px-2.5 py-1">
      <View
        accessible={false}
        className={
          live
            ? "size-1.5 rounded-full bg-live"
            : "size-1.5 rounded-full border border-muted-foreground"
        }
      />
      <Text
        {...{ role: "caption" }}
        accessibilityLiveRegion={active && state !== "live" ? "polite" : "none"}
        className="shrink tabular-nums"
      >
        {state === "live" && !live
          ? "Connecting"
          : state === "live" && active
            ? connection.route
              ? `Live · ${connection.route} ${age}`
              : `Live · ${age}`
            : label}
      </Text>
    </View>
  );
}
