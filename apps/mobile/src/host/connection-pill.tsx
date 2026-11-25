import type { HostId } from "@core/generated/types";
import {
  hostStatusSummary,
  type PhoneRemoteHostStatus,
} from "@core/remote-errors";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { shallow } from "zustand/shallow";
import { useHostLive, useLastFrame, useLiveFailure } from "@/data/live";
import { Text } from "@/ui/text";

const routeNames = { lan: "LAN", tailscale: "Tailscale" };

/** The remote status line used by both the host and module pages. */
export function offlineLabel(remote: PhoneRemoteHostStatus | undefined) {
  return remote && remote.state !== "connected"
    ? hostStatusSummary(remote, { nowMs: Date.now() }).label
    : null;
}

/** Select connection changes that affect the page, leaving frame age to the pill. */
export function useConnection(
  host: HostId,
  remote: PhoneRemoteHostStatus | undefined,
  statusError: string | null
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
  const failure = useLiveFailure(host);
  const offline = statusError ?? offlineLabel(remote) ?? failure;

  if (offline) {
    return {
      state:
        !statusError && remote?.state === "connecting"
          ? "reconnecting"
          : "offline",
      label: offline,
    } as const;
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
  if (connection !== "live")
    return { state: "waiting", label: "Connecting" } as const;
  const route = remote?.route ? routeNames[remote.route] : null;
  return {
    state: "live",
    label: remote
      ? hostStatusSummary(remote, { nowMs: Date.now() }).label
      : "Live",
    route,
  } as const;
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
              ? `${label} · ${connection.route} ${age}`
              : `${label} · ${age}`
            : label}
      </Text>
    </View>
  );
}
