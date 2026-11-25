import type { HostId, HostRecord } from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { hostClock } from "@core/host-clock";
import {
  type PhoneRemoteHostRecord,
  phoneProblem,
  phoneWaitingForNetwork,
} from "@core/phone-connection";
import { historyKeys, hostKeys } from "@core/query-keys";
import { failureReason } from "@core/remote-errors";
import { MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo } from "react";
import { usePhoneTransport } from "./transport-context";

const CPU = "cpu.total";
const SPARKLINE_MS = 30 * MINUTE_MS;

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

function useRemoteStatuses<T>(
  select: (records: PhoneRemoteHostRecord[]) => T,
  enabled = true
) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  return useQuery({
    queryKey: hostKeys.remote(),
    queryFn: () => transport.listRemoteHosts(),
    enabled: focused && enabled,
    select,
  });
}

/** One host's connection record, updated by the screen's event subscription. */
export function useHostStatus(id: HostId, enabled = true) {
  return useRemoteStatuses(
    (records) => records.find(({ config }) => config.id === id) ?? null,
    enabled
  );
}

/** A focused host page owns status updates while the hosts list is blurred. */
export function useHostConnection(id: HostId, active: boolean) {
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  const focused = useIsFocused();
  useEffect(() => {
    if (!active || !focused) return;
    return transport.onRemoteHostsChanged(() => {
      void cache.invalidateQueries({ queryKey: hostKeys.remote() });
    });
  }, [active, cache, focused, transport]);
  return useHostStatus(id, active);
}

/** Report network loss once for the visible remote hosts. */
export function useHostsWaitingForNetwork(hosts: readonly HostRecord[]) {
  const status = useRemoteStatuses((records) => {
    const remotes = hosts.filter(({ is_local }) => !is_local);
    return (
      remotes.length > 0 &&
      remotes.every(({ id }) =>
        records.some(
          ({ config, status }) =>
            config.id === id && phoneWaitingForNetwork(status)
        )
      )
    );
  });
  return status.isSuccess && status.data;
}

/** Host headlines, polled every five seconds on the focused screen. */
export function useHostVitals(id: HostId, connected: boolean) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  return useQuery({
    queryKey: hostKeys.vitals(id),
    queryFn: () => unwrap(transport.hostVitals(id)),
    enabled: focused && connected,
    refetchInterval: 5_000,
  });
}

const sparklineKey = (id: HostId) => historyKeys.recent(id, SPARKLINE_MS);

/** Discard readings from the previous connection before the row goes live again. */
export function useClearOfflineHostReadings(id: HostId, connected: boolean) {
  const cache = useQueryClient();
  useEffect(() => {
    if (connected) return;
    void cache.resetQueries({ queryKey: hostKeys.vitals(id), exact: true });
    void cache.resetQueries({ queryKey: sparklineKey(id), exact: true });
  }, [cache, connected, id]);
}

/** The last thirty minutes of CPU history. */
export function useHostSparkline(id: HostId) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  const status = useHostStatus(id);
  const local = useQuery({
    queryKey: hostKeys.list(),
    queryFn: () => transport.listHosts(),
    select: (hosts) => hosts.some((host) => host.id === id && host.is_local),
    enabled: focused && status.isSuccess && status.data === null,
    // The visible hosts query and registry events already keep this cache fresh.
    staleTime: Infinity,
  });
  const remote = status.data?.status;
  const offsetMs = local.data
    ? 0
    : remote?.state === "connected"
      ? remote.clock_offset_ms
      : null;
  const now = useMemo(() => hostClock(offsetMs ?? 0), [offsetMs]);
  return useQuery({
    queryKey: sparklineKey(id),
    queryFn: async (): Promise<StreamAreaData | null> => {
      const toMs = Math.round(now());
      const fromMs = toMs - SPARKLINE_MS;
      const page = await unwrap(
        transport.hostHistory({
          host: id,
          series: [{ metric: CPU, labels: [] }],
          from_ms: fromMs,
          to_ms: toMs,
          max_points: 31,
          events_for: null,
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
    enabled: focused && status.isSuccess && offsetMs !== null,
    refetchInterval: MINUTE_MS,
  });
}

export interface HostRetryFailure {
  id: HostId;
  displayName: string;
  reason: string;
}

/** Retry the offline rows that can reconnect, then refresh the visible list. */
export function useRefreshHosts() {
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  const statuses = useRemoteStatuses((records) => records);
  return async (hosts: readonly HostRecord[]) => {
    const offline = new Set(
      statuses.data
        ?.filter((record) => {
          return (
            record.config.enabled && phoneProblem(record)?.action === "retry"
          );
        })
        .map(({ config }) => config.id)
    );
    const failures = await Promise.all(
      hosts
        .filter(({ id }) => offline.has(id))
        .map(async ({ id, display_name }): Promise<HostRetryFailure | null> => {
          try {
            await unwrap(transport.retryRemoteHost(id));
            return null;
          } catch (error) {
            console.warn("Could not reconnect host", id, error);
            return {
              id,
              displayName: display_name,
              reason: failureReason(error, "Pull down to try again."),
            };
          }
        })
    );
    await Promise.all([
      cache.invalidateQueries({ queryKey: hostKeys.list() }),
      cache.invalidateQueries({ queryKey: hostKeys.remote() }),
      ...hosts.flatMap(({ id }) => [
        cache.invalidateQueries({ queryKey: hostKeys.vitals(id) }),
        cache.invalidateQueries({ queryKey: sparklineKey(id) }),
      ]),
    ]);
    return failures.filter((failure) => failure !== null);
  };
}
