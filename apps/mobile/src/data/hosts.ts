import type { HostId, HostRecord } from "@core/generated/types";
import {
  type PhoneRemoteHostRecord,
  phoneProblem,
  phoneWaitingForNetwork,
} from "@core/phone-connection";
import { historyKeys, hostKeys } from "@core/query-keys";
import { failureReason } from "@core/remote-errors";
import { unwrap } from "@core/transport";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useContext, useEffect } from "react";
import { useWindowDimensions } from "react-native";
import { RowVisibility } from "./demand";
import { historyPointBudget } from "./history";
import { useAppActive } from "./live";
import { SPARKLINE_MS } from "./sparkline-model";
import { useIsDemo, usePhoneTransport } from "./transport-context";

const CPU = "cpu.total";

/** Metrics in the order used by the row history and live summaries. */
export const ROW_METRICS = [
  CPU,
  "mem.used",
  "net.rx_total",
  "net.tx_total",
] as const;

/** Unlabeled series requested for the row sparkline. */
export const ROW_SERIES = ROW_METRICS.map((metric) => ({ metric, labels: [] }));

/** Refresh the shared host queries from one subscription per focused list. */
export function useHostListUpdates() {
  const transport = usePhoneTransport();
  const demo = useIsDemo();
  const cache = useQueryClient();
  useFocusEffect(
    useCallback(() => {
      const stopHosts = transport.onHostsChanged(({ hosts }) => {
        void cache
          .cancelQueries({ queryKey: hostKeys.list(), exact: true })
          .then(() => {
            cache.setQueryData(hostKeys.list(), hosts);
            void cache.invalidateQueries({ queryKey: hostKeys.pairing() });
          });
      });
      const stopRemote = transport.onRemoteHostsChanged(() => {
        void cache.invalidateQueries({ queryKey: hostKeys.remote() });
        if (!demo)
          void cache.invalidateQueries({
            queryKey: hostKeys.list(),
            exact: true,
          });
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
    }, [cache, demo, transport])
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

export function useControllerRemovedHosts(enabled: boolean) {
  return useRemoteStatuses(
    (records) =>
      records
        .filter(({ status }) => status.removed_by_controller)
        .map(({ config }) => config.id),
    enabled
  );
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

/** Headline readings while the row is waiting for summaries or memory capacity. */
export function useHostVitals(id: HostId, connected: boolean) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  const active = useAppActive();
  const visible = useContext(RowVisibility)?.visible ?? true;
  return useQuery({
    queryKey: hostKeys.vitals(id),
    queryFn: () => unwrap(transport.hostVitals(id)),
    enabled: focused && active && visible && connected,
  });
}

/** The cache key for a row sparkline at the given width. */
export const sparklineKey = (id: HostId, width: number) =>
  historyKeys.hostHistory(
    id,
    ROW_SERIES,
    { windowMs: SPARKLINE_MS },
    historyPointBudget(width)
  );

/** Discard readings from the previous connection before the row goes live again. */
export function useClearOfflineHostReadings(id: HostId, connected: boolean) {
  const cache = useQueryClient();
  const window = useWindowDimensions();
  const width = useContext(RowVisibility)?.width ?? window.width;
  useEffect(() => {
    if (connected) return;
    void cache.resetQueries({ queryKey: hostKeys.vitals(id), exact: true });
    void cache.resetQueries({ queryKey: sparklineKey(id, width), exact: true });
  }, [cache, connected, id, width]);
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
      cache.invalidateQueries({ queryKey: hostKeys.pairing() }),
      ...hosts.flatMap(({ id }) => [
        cache.invalidateQueries({ queryKey: hostKeys.vitals(id) }),
        cache.invalidateQueries({ queryKey: historyKeys.host(id) }),
      ]),
    ]);
    return failures.filter((failure) => failure !== null);
  };
}
