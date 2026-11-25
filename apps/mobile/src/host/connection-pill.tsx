import { formatClock } from "@core/format";
import type { HostId, RemoteHostStatus } from "@core/generated/types";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { shallow } from "zustand/shallow";
import { useHostLive, useLastFrame, useLiveFailure } from "@/data/live";
import { Text } from "@/ui/text";

export function offlineLabel(remote: RemoteHostStatus | undefined) {
  if (!remote || !["offline", "error", "disabled"].includes(remote.state))
    return null;
  return remote.last_seen_ms === null
    ? "Offline"
    : `Offline since ${formatClock(remote.last_seen_ms)}`;
}

export function useConnection(
  host: HostId,
  remote: RemoteHostStatus | undefined
) {
  const { connection, stale, paused, idle } = useHostLive(
    host,
    (s) => ({
      connection: s.connection,
      stale: s.stale,
      paused: s.status?.paused,
      idle: s.status?.display_idle,
    }),
    shallow
  );
  const lastFrame = useLastFrame(host);
  const failure = useLiveFailure(host);
  const offline = failure ?? offlineLabel(remote);

  if (offline) return { state: "offline", label: offline } as const;
  if (remote?.state === "connecting") {
    return { state: "reconnecting", label: "Reconnecting" } as const;
  }
  if (paused || idle) {
    return {
      state: "waiting",
      label: paused ? "Paused" : "Display asleep",
    } as const;
  }
  if (stale || connection === "reconnecting") {
    return { state: "reconnecting", label: "Reconnecting" } as const;
  }
  if (lastFrame === null)
    return { state: "waiting", label: "Connecting" } as const;
  const route =
    remote?.route === "lan"
      ? "LAN"
      : remote?.route === "tailscale"
        ? "Tailscale"
        : null;
  return { state: "live", label: "Live", route, lastFrame } as const;
}

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

export function ConnectionPill({
  connection,
  active,
}: {
  connection: ReturnType<typeof useConnection>;
  active: boolean;
}) {
  const { label, state } = connection;
  const lastFrame = state === "live" && active ? connection.lastFrame : null;
  const age = useFrameAge(lastFrame);
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
          state === "live"
            ? "size-1.5 rounded-full bg-live"
            : "size-1.5 rounded-full border border-muted-foreground"
        }
      />
      <Text
        {...{ role: "caption" }}
        accessibilityLiveRegion={active && state !== "live" ? "polite" : "none"}
        className="shrink tabular-nums"
      >
        {state === "live" && active
          ? connection.route
            ? `Live · ${connection.route} ${age}`
            : `Live · ${age}`
          : label}
      </Text>
    </View>
  );
}
