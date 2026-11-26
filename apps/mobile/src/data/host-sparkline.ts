/** The hosts-list row's sparkline data. */
import { commandError } from "@core/command-error";
import type {
  HistoryPage,
  HostHistoryPage,
  HostId,
  LiveMsg,
  Module,
} from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { gapBands } from "@core/history-state";
import { hostClock } from "@core/host-clock";
import { hostKeys } from "@core/query-keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useContext, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { QUERY_DEFAULTS } from "@/lib/query-client";
import { RowVisibility, useFocusDemand } from "./demand";
import {
  type HistoryRange,
  historyPointBudget,
  useHostHistory,
} from "./history";
import { ROW_METRICS, ROW_SERIES, sparklineKey, useHostStatus } from "./hosts";
import { useFocusedAppEffect } from "./live";
import {
  appendSummary,
  networkSparkbars,
  percentSparkline,
  SPARKLINE_MS,
  SUMMARY_MS,
  type Summary,
  sparkWindow,
} from "./sparkline-model";
import { usePhoneTransport } from "./transport-context";

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
