import type { HostId } from "@core/generated/types";
import {
  hostStatusSummary,
  type PhoneRemoteHostStatus,
} from "@core/phone-connection";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useStatusAnnouncement } from "@/connection/use-status-announcement";
import { type useConnection, useLastFrame } from "@/data/live";
import { Text } from "@/ui/text";

function useConnectionAnnouncement(
  connection: ReturnType<typeof useConnection>,
  active: boolean
) {
  const { label, state, remoteState, problemKind } = connection;
  const announce = active && (state === "offline" || state === "reconnecting");
  useStatusAnnouncement(
    announce ? label : null,
    announce ? `${state}:${remoteState ?? ""}:${problemKind ?? ""}` : null
  );
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

function pillLabel(
  connection: ReturnType<typeof useConnection>,
  status: PhoneRemoteHostStatus | undefined,
  hasFrame: boolean,
  active: boolean,
  age: string
) {
  if (connection.state !== "live") return connection.label;
  if (status?.state === "connected" && status.demand === "compact") {
    return hostStatusSummary(status, {
      nowMs: Date.now(),
      requestedDemand: "full",
    }).label;
  }
  if (!hasFrame) return "Connecting";
  if (!active) return connection.label;
  return connection.route
    ? `${connection.label} · ${connection.route} ${age}`
    : `${connection.label} · ${age}`;
}

/** Show the connection and announce outages. Frame updates stop at this component. */
export function ConnectionPill({
  host,
  connection,
  status,
  active,
}: {
  host: HostId;
  connection: ReturnType<typeof useConnection>;
  status: PhoneRemoteHostStatus | undefined;
  active: boolean;
}) {
  const { state } = connection;
  const lastFrame = useLastFrame(host);
  const live = state === "live" && lastFrame !== null;
  const age = useFrameAge(
    live && active && status?.demand !== "compact" ? lastFrame : null
  );
  useConnectionAnnouncement(connection, active);

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
        variant="caption"
        accessibilityLiveRegion={active && state !== "live" ? "polite" : "none"}
        className="shrink tabular-nums"
      >
        {pillLabel(connection, status, live, active, age)}
      </Text>
    </View>
  );
}
