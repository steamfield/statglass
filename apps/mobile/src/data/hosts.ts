import { formatClock } from "@core/format";
import type {
  HostId,
  HostRecord,
  RemoteHostRecord,
  RemoteHostStatus,
} from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { hostClock } from "@core/host-clock";
import { historyKeys, hostKeys } from "@core/query-keys";
import { failureReason } from "@core/remote-errors";
import { MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useMemo } from "react";
import { usePhoneTransport } from "./transport-context";

const CPU = "cpu.total";
const SPARKLINE_MS = 30 * MINUTE_MS;
const needsAttention = new Set<RemoteHostStatus["failure_kind"]>([
  "authentication",
  "host_key",
  "incompatible",
  "identity_changed",
  "protocol",
]);

/** Refresh the shared host queries from one subscription per focused list. */
export function useHostListUpdates() {
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  useFocusEffect(
    useCallback(() => {
      const stopHosts = transport.onHostsChanged(({ hosts }) =>
        cache.setQueryData(hostKeys.list(), hosts)
      );
      const stopRemote = transport.onRemoteHostsChanged(() => {
        void cache.invalidateQueries({ queryKey: hostKeys.remote() });
      });
      if (cache.getQueryData(hostKeys.list()) !== undefined) {
        // The registry may have changed while this screen was blurred.
        void cache.invalidateQueries(
          { queryKey: hostKeys.list() },
          { cancelRefetch: false }
        );
      }
      return () => {
        stopHosts();
        stopRemote();
      };
    }, [cache, transport])
  );
}

function useRemoteStatuses<T>(select: (records: RemoteHostRecord[]) => T) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  return useQuery({
    queryKey: hostKeys.remote(),
    queryFn: () => transport.listRemoteHosts(),
    enabled: focused,
    select,
  });
}

/** One host's connection status, updated by the list's shared event subscription. */
export function useHostStatus(id: HostId) {
  return useRemoteStatuses(
    (records) => records.find(({ config }) => config.id === id)?.status ?? null
  );
}

/** Host headlines, polled every five seconds on the focused screen. */
export function useHostVitals(id: HostId) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  return useQuery({
    queryKey: hostKeys.vitals(id),
    queryFn: () => unwrap(transport.hostVitals(id)),
    enabled: focused,
    refetchInterval: 5_000,
  });
}

const sparklineKey = (id: HostId) => historyKeys.recent(id, SPARKLINE_MS);

/** The last thirty minutes of CPU history at the mirror's minute resolution. */
export function useHostSparkline(id: HostId, offsetMs: number | null = 0) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  const now = useMemo(() => hostClock(offsetMs ?? 0), [offsetMs]);
  return useQuery({
    queryKey: sparklineKey(id),
    queryFn: async (): Promise<StreamAreaData | null> => {
      const toMs = Math.round(now());
      const fromMs = toMs - SPARKLINE_MS;
      const page = await unwrap(
        transport.queryHistory({
          host: id,
          selectors: [{ metric: CPU, labels: [] }],
          from_ms: fromMs,
          to_ms: toMs,
          tier: "m1",
          max_points: 31,
        })
      );
      const grid = historyGrid(page, [CPU], fromMs, toMs);
      const values = grid.values[CPU];
      if (!values?.some((value) => value !== null)) return null;
      return {
        accent: "cpu",
        height: 28,
        yMax: 100,
        intervalMs: grid.bucketMs,
        tEndMs: grid.endMs,
        series: [{ key: CPU, values, step: 1 }],
        ariaLabel: "CPU history over the last 30 minutes",
      };
    },
    enabled: focused && offsetMs !== null,
    refetchInterval: MINUTE_MS,
  });
}

function connectionKind(status: RemoteHostStatus) {
  switch (status.state) {
    case "connected":
      return "live";
    case "disabled":
      return "disabled";
    case "connecting":
      return status.error === null ? "connecting" : "offline";
    default:
      return needsAttention.has(status.failure_kind) ? "attention" : "offline";
  }
}

/** The row's compact connection wording and color role. */
export function hostStatusLabel(
  local: boolean,
  status: RemoteHostStatus | null
) {
  if (local) return { text: "Live", tone: "live" } as const;
  if (!status) return { text: "Status unavailable", tone: "muted" } as const;
  const kind = connectionKind(status);
  if (kind === "live") return { text: "Live", tone: "live" } as const;
  if (kind === "attention")
    return { text: "Needs attention", tone: "warning" } as const;
  if (kind === "connecting")
    return { text: "Connecting", tone: "muted" } as const;
  if (status.last_seen_ms !== null && kind === "offline") {
    const time = formatClock(
      status.last_seen_ms + (status.clock_offset_ms ?? 0)
    );
    return { text: `Offline since ${time}`, tone: "muted" } as const;
  }
  return { text: "Offline", tone: "muted" } as const;
}

/** Retry the offline rows that can reconnect, then refresh the visible list. */
export function useRefreshHosts() {
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  const statuses = useRemoteStatuses((records) => records);
  return async (hosts: readonly HostRecord[]) => {
    const ids = new Set(hosts.map((host) => host.id));
    const offline =
      statuses.data?.filter(
        ({ config, status }) =>
          ids.has(config.id) &&
          config.enabled &&
          connectionKind(status) === "offline"
      ) ?? [];
    const retries = await Promise.allSettled(
      offline.map(({ config }) => unwrap(transport.retryRemoteHost(config.id)))
    );
    await Promise.all([
      cache.invalidateQueries({ queryKey: hostKeys.list() }),
      cache.invalidateQueries({ queryKey: hostKeys.remote() }),
      ...hosts.flatMap(({ id }) => [
        cache.invalidateQueries({ queryKey: hostKeys.vitals(id) }),
        cache.invalidateQueries({ queryKey: sparklineKey(id) }),
      ]),
    ]);
    const failed = retries.find((retry) => retry.status === "rejected");
    return failed
      ? `Couldn’t reconnect. ${failureReason(failed.reason, "Pull down to try again.")}`
      : null;
  };
}
