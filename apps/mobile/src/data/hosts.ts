import { commandError } from "@core/command-error";
import type { HostId, HostRecord, LiveMsg } from "@core/generated/types";
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
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { QUERY_DEFAULTS } from "@/lib/query-client";
import { RowVisibility, useFocusDemand } from "./demand";
import {
  type HistoryRange,
  historyPointBudget,
  useHostHistory,
} from "./history";
import { useAppActive, useFocusedAppEffect } from "./live";
import { usePhoneTransport } from "./transport-context";

const CPU = "cpu.total";
const SPARKLINE_MS = 30 * MINUTE_MS;
const SUMMARY_MS = 5_000;
const ROW_METRICS = [CPU, "mem.used", "net.rx_total", "net.tx_total"] as const;
const ROW_SERIES = ROW_METRICS.map((metric) => ({ metric, labels: [] }));

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

/** The row's latest host-side summary, refreshed when its stream delivers a frame. */
export function useHostVitals(id: HostId, connected: boolean) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  const active = useAppActive();
  const visible = useContext(RowVisibility)?.visible ?? true;
  useFocusDemand(visible ? id : null, "compact");
  return useQuery({
    queryKey: hostKeys.vitals(id),
    queryFn: () => unwrap(transport.hostVitals(id)),
    enabled: focused && active && visible && connected,
  });
}

const sparklineKey = (id: HostId, width: number) =>
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

type Summary = { ts: number; timeline: number; values: (number | null)[] };

function useRowSummaries(id: HostId, visible: boolean, refresh: number) {
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [failure, setFailure] = useState<{
    refresh: number;
    reason: unknown;
  } | null>(null);
  useFocusedAppEffect(
    useCallback(() => {
      return visible ? () => setSummaries([]) : undefined;
    }, [visible])
  );
  useFocusedAppEffect(
    useCallback(() => {
      if (!visible) return;
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let layout: number | undefined;
      let indices: number[] = [];
      const onMessage = (message: LiveMsg) => {
        if (stopped) return;
        if (message.kind === "layout") {
          layout = message.layout_no;
          indices = ROW_METRICS.map((metric) =>
            message.series.findIndex(
              (key) => key.metric === metric && !key.labels.length
            )
          );
        }
        if (message.kind !== "frame" || message.layout_no !== layout) return;
        const { ts_ms: ts, held, timeline } = message;
        const values = indices.map((i) => held[i] ?? null);
        setSummaries((previous) => [
          ...(previous.at(-1)?.timeline === timeline
            ? previous.filter(
                (point) => point.ts < ts && point.ts > ts - SPARKLINE_MS
              )
            : []),
          { ts, timeline, values },
        ]);
        void cache.invalidateQueries({
          queryKey: hostKeys.vitals(id),
          exact: true,
        });
      };
      const reportFailure = (reason: unknown, attempt: number) => {
        if (stopped) return;
        if (QUERY_DEFAULTS.queries.retry(attempt, reason)) {
          retry = setTimeout(() => void start(attempt + 1), 1_000);
        } else {
          setFailure({ refresh, reason });
        }
      };
      const start = async (attempt: number): Promise<void> => {
        try {
          const subscription = await transport.subscribeLive(id, onMessage, {
            series: ROW_SERIES,
            backfillMs: 0,
          });
          if (stopped || subscription.info.status === "error") {
            subscription.unsubscribe();
            if (subscription.info.status === "error")
              throw subscription.info.error;
            return;
          }
          unsubscribe = subscription.unsubscribe;
          setFailure(null);
        } catch (reason) {
          reportFailure(reason, attempt);
        }
      };
      void start(0);
      return () => {
        stopped = true;
        clearTimeout(retry);
        unsubscribe?.();
        setFailure(null);
      };
    }, [cache, id, refresh, transport, visible])
  );
  return {
    summaries,
    error: failure?.refresh === refresh ? failure.reason : null,
  };
}

function cpuSparkline(
  history: ReturnType<typeof historyGrid> | null,
  historyEnd: number,
  summaries: readonly Summary[]
): StreamAreaData | null {
  const latest = summaries.at(-1);
  const historyCpu = history?.values[CPU];
  let values = historyCpu ?? [];
  let tEndMs = history?.endMs ?? 0;
  let intervalMs = history?.bucketMs ?? SUMMARY_MS;
  if (latest) {
    tEndMs = latest.ts;
    intervalMs = SUMMARY_MS;
    const count = SPARKLINE_MS / SUMMARY_MS + 1;
    const start = tEndMs - (count - 1) * intervalMs;
    const historyStart =
      history && historyCpu
        ? history.endMs - (historyCpu.length - 1) * history.bucketMs
        : 0;
    values = Array.from({ length: count }, (_, i) => {
      // Plot the host's bucket average across the span the bucket covers.
      const ts = start + i * intervalMs;
      if (!history || !historyCpu || ts >= historyEnd) return null;
      const bucket = Math.floor((ts - historyStart) / history.bucketMs);
      return historyCpu[bucket] ?? null;
    });
    // Keep distinct samples when host timestamps round to the same grid slot.
    // Place the newer sample first and use the previous slot for the older one.
    let next = count;
    for (const sample of summaries.slice().reverse()) {
      const i = Math.min(
        next - 1,
        Math.round((sample.ts - start) / intervalMs)
      );
      if (i < 0) break;
      values[i] = sample.values[0] ?? null;
      next = i;
    }
  }
  if (!values.some((value) => value !== null)) return null;
  return {
    accent: "cpu",
    height: 28,
    yMax: 100,
    intervalMs,
    tEndMs,
    series: [{ key: CPU, values, step: 1 }],
    ariaLabel: "CPU history over the last 30 minutes",
  };
}

/** One bounded history read, with subsequent summaries appended while the row is visible. */
export function useHostSparkline(id: HostId) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  const row = useContext(RowVisibility);
  const window = useWindowDimensions();
  const visible = row?.visible ?? true;
  useFocusDemand(visible ? id : null, "compact");
  const status = useHostStatus(id);
  const local = useQuery({
    queryKey: hostKeys.list(),
    queryFn: () => transport.listHosts(),
    select: (hosts) => hosts.some((host) => host.id === id && host.is_local),
    enabled: visible && focused && status.isSuccess && status.data === null,
    // The visible hosts query and registry events already keep this cache fresh.
    staleTime: Infinity,
  });
  const remote = status.data?.status;
  const offsetMs = local.data
    ? 0
    : remote?.state === "connected"
      ? remote.clock_offset_ms
      : null;
  const range = useMemo<HistoryRange>(() => {
    const toMs = Math.floor(hostClock(offsetMs ?? 0)());
    return {
      rolling: true,
      offsetMs: offsetMs ?? 0,
      fromMs: toMs - SPARKLINE_MS,
      toMs,
    };
  }, [offsetMs]);
  const history = useHostHistory(
    id,
    ROW_SERIES,
    range,
    row?.width ?? window.width,
    null,
    visible && status.isSuccess && offsetMs !== null,
    false
  );
  const { summaries, error } = useRowSummaries(
    id,
    visible && offsetMs !== null,
    row?.refresh ?? 0
  );
  const grid = useMemo(
    () =>
      history.data
        ? historyGrid(
            history.data.page,
            ROW_METRICS,
            history.data.range.fromMs,
            history.data.range.toMs
          )
        : null,
    [history.data]
  );
  const historyEnd = history.data
    ? Math.min(history.data.range.toMs, history.data.page.complete_to_ms)
    : 0;
  const data = useMemo(
    () => cpuSparkline(grid, historyEnd, summaries),
    [grid, historyEnd, summaries]
  );
  return {
    data,
    error:
      commandError(history.error)?.kind === "remote_unsupported"
        ? error
        : (history.error ?? error),
  };
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
        cache.invalidateQueries({ queryKey: historyKeys.host(id) }),
      ]),
    ]);
    return failures.filter((failure) => failure !== null);
  };
}
