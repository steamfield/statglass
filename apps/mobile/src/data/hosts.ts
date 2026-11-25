import { commandError } from "@core/command-error";
import type {
  HistoryPage,
  HostHistoryPage,
  HostId,
  HostRecord,
  LiveMsg,
  Module,
} from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { gapBands } from "@core/history-state";
import { hostClock } from "@core/host-clock";
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
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import {
  appendSummary,
  networkSparkbars,
  percentSparkline,
  SPARKLINE_MS,
  SUMMARY_MS,
  type Summary,
  sparkWindow,
} from "@/hosts/sparkline-model";
import { QUERY_DEFAULTS } from "@/lib/query-client";
import { RowVisibility, useFocusDemand } from "./demand";
import {
  type HistoryRange,
  historyPointBudget,
  useHostHistory,
} from "./history";
import { pairingKey } from "./hosts-list";
import { useAppActive, useFocusedAppEffect } from "./live";
import { useIsDemo, usePhoneTransport } from "./transport-context";

const CPU = "cpu.total";
const ROW_METRICS = [CPU, "mem.used", "net.rx_total", "net.tx_total"] as const;
const ROW_SERIES = ROW_METRICS.map((metric) => ({ metric, labels: [] }));

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
            void cache.invalidateQueries({ queryKey: pairingKey });
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

function useRowSummaries(
  id: HostId,
  visible: boolean,
  refresh: number,
  width: number
) {
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [stale, setStale] = useState(false);
  const [paused, setPaused] = useState(false);
  const [failure, setFailure] = useState<{
    refresh: number;
    reason: unknown;
  } | null>(null);
  useFocusedAppEffect(
    useCallback(() => {
      return visible
        ? () => {
            setSummaries([]);
            setStale(false);
            setPaused(false);
            // The next opening needs the history the row missed while hidden.
            cache.removeQueries({
              queryKey: sparklineKey(id, width),
              exact: true,
            });
          }
        : undefined;
    }, [cache, id, visible, width])
  );
  useFocusedAppEffect(
    useCallback(() => {
      if (!visible) return;
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let staleTimer: ReturnType<typeof setTimeout> | undefined;
      let intervalMs = SUMMARY_MS;
      let expecting = true;
      let layout: number | undefined;
      let indices: number[] = [];
      const expectSummary = () => {
        clearTimeout(staleTimer);
        if (expecting)
          staleTimer = setTimeout(() => setStale(true), 3 * intervalMs);
      };
      expectSummary();
      const onMessage = (message: LiveMsg) => {
        if (stopped) return;
        switch (message.kind) {
          case "status":
            intervalMs = Math.max(SUMMARY_MS, message.frame_period_ms);
            expecting = !message.paused && message.frame_period_ms > 0;
            setPaused(message.paused);
            if (!expecting) setStale(false);
            expectSummary();
            break;
          case "layout":
            layout = message.layout_no;
            indices = ROW_METRICS.map((metric) =>
              message.series.findIndex(
                (key) => key.metric === metric && !key.labels.length
              )
            );
            break;
          case "frame": {
            if (message.layout_no !== layout) break;
            setStale(false);
            expectSummary();
            const { ts_ms: ts, held, timeline } = message;
            const values = indices.map((i) => held[i] ?? null);
            setSummaries((previous) =>
              appendSummary(previous, { ts, timeline, intervalMs, values })
            );
            break;
          }
        }
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
            minPeriodMs: SUMMARY_MS,
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
        clearTimeout(staleTimer);
        unsubscribe?.();
        setFailure(null);
      };
    }, [id, refresh, transport, visible])
  );
  return {
    summaries,
    stale,
    paused,
    error: failure?.refresh === refresh ? failure.reason : null,
  };
}

function rowHistory(page: HostHistoryPage, range: HistoryRange) {
  const gridFor = (page: HistoryPage) =>
    historyGrid(page, ROW_METRICS, range.fromMs, range.toMs);
  return {
    averages: gridFor(page),
    bands: gapBands(page.gaps, range.fromMs, range.toMs).map((band) => ({
      ...band,
      showCaption: false,
    })),
    maxima: gridFor({
      ...page,
      series: page.series.map((series) => ({
        ...series,
        points: series.points.map((point) => ({
          ...point,
          avg: point.max ?? point.avg,
        })),
      })),
    }),
    // A full reply also covers the right edge of the requested plot.
    endMs:
      page.complete_to_ms < range.toMs ? page.complete_to_ms - 1 : range.toMs,
  };
}

function rowCharts(
  history: ReturnType<typeof rowHistory> | null,
  summaries: readonly Summary[],
  memoryBytes: number,
  width: number
) {
  const historyEnd = history?.endMs ?? 0;
  const {
    values: [cpu = [], bytes = [], down = [], up = []],
    ...timing
  } = sparkWindow(
    history?.averages ?? null,
    historyEnd,
    summaries,
    ROW_METRICS
  );
  const {
    values: [cpuMax = [], bytesMax = [], downMax = [], upMax = []],
  } = sparkWindow(history?.maxima ?? null, historyEnd, summaries, ROW_METRICS);
  const memory = bytes.map((value) => memoryPercent(value, memoryBytes));
  const memoryMax = bytesMax.map((value) => memoryPercent(value, memoryBytes));
  const latest = summaries.at(-1)?.values;
  const bandsFor = (module: Module) =>
    history?.bands.filter(
      (band) => band.module === null || band.module === module
    ) ?? [];
  return {
    data: percentSparkline("cpu", cpu, cpuMax, timing, bandsFor("cpu")),
    memory: percentSparkline(
      "mem",
      memory,
      memoryMax,
      timing,
      bandsFor("memory")
    ),
    network: networkSparkbars(
      down,
      up,
      downMax,
      upMax,
      timing,
      historyPointBudget(width),
      bandsFor("network")
    ),
    latest: latest && {
      cpu_pct: latest[0] ?? null,
      memory_pct: memoryPercent(latest[1] ?? null, memoryBytes),
      net_rx_bps: latest[2] ?? null,
      net_tx_bps: latest[3] ?? null,
    },
  };
}

/** One bounded history read, with subsequent summaries appended while the row is visible. */
export function useHostSparkline(id: HostId, memoryBytes = 0, allowed = true) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  const row = useContext(RowVisibility);
  const window = useWindowDimensions();
  const visible = row?.visible ?? true;
  useFocusDemand(visible && allowed ? id : null, "compact");
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
  const width = row?.width ?? window.width;
  const connected = allowed && status.isSuccess && offsetMs !== null;
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
    width,
    null,
    visible && connected,
    false
  );
  const { summaries, error, stale, paused } = useRowSummaries(
    id,
    visible && connected,
    row?.refresh ?? 0,
    width
  );
  const { data: answer } = history;
  const grid = useMemo(
    () => (answer ? rowHistory(answer.page, answer.range) : null),
    [answer]
  );
  const charts = useMemo(
    () => rowCharts(grid, summaries, memoryBytes, width),
    [grid, memoryBytes, summaries, width]
  );
  return {
    ...charts,
    stale,
    paused,
    summaryError: error,
    error:
      commandError(history.error)?.kind === "remote_unsupported"
        ? null
        : history.error,
  };
}

function memoryPercent(value: number | null, capacity: number) {
  return value === null || capacity <= 0 ? null : (value / capacity) * 100;
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
      cache.invalidateQueries({ queryKey: pairingKey }),
      ...hosts.flatMap(({ id }) => [
        cache.invalidateQueries({ queryKey: hostKeys.vitals(id) }),
        cache.invalidateQueries({ queryKey: historyKeys.host(id) }),
      ]),
    ]);
    return failures.filter((failure) => failure !== null);
  };
}
