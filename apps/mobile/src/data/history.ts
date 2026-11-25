import { RANGE_PRESETS } from "@core/chart-range";
import { commandError } from "@core/command-error";
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatWatts,
} from "@core/format";
import type { HostId, Module, SeriesSelector } from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { historyUnavailable } from "@core/history-state";
import { hostClock } from "@core/host-clock";
import type { PopoverCard } from "@core/popover/card-order";
import { historyKeys } from "@core/query-keys";
import { failureReason, remoteQueryText } from "@core/remote-errors";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import type { Accent } from "@core/widget-models/tokens";
import { CancelledError, useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { shallow } from "zustand/shallow";
import {
  useFocusedAppEffect,
  useHostLive,
  useHostLiveSubscription,
} from "./live";
import { usePhoneTransport } from "./transport-context";

interface HistoryModule {
  title: string;
  accent: Accent;
  series: readonly { key: string; label: string }[];
  format: (value: number | null) => string;
  ceiling?: number;
}

/** Titles, units, series and scales for the modules with a phone history page. */
export const HISTORY_MODULES: Record<PopoverCard, HistoryModule> = {
  cpu: {
    title: "CPU",
    accent: "cpu",
    series: [{ key: "cpu.total", label: "CPU usage" }],
    format: formatPercent,
    ceiling: 100,
  },
  memory: {
    title: "Memory",
    accent: "mem",
    series: [{ key: "mem.used", label: "Memory used" }],
    format: formatBytes,
  },
  gpu: {
    title: "GPU",
    accent: "gpu",
    series: [{ key: "gpu.util", label: "GPU usage" }],
    format: formatPercent,
    ceiling: 100,
  },
  power: {
    title: "Power",
    accent: "power",
    series: [{ key: "power.system", label: "System power" }],
    format: formatWatts,
  },
  network: {
    title: "Network",
    accent: "net",
    series: [
      { key: "net.rx_total", label: "Download" },
      { key: "net.tx_total", label: "Upload" },
    ],
    format: formatRate,
  },
  battery: {
    title: "Battery",
    accent: "battery",
    series: [{ key: "battery.charge", label: "Battery charge" }],
    format: formatPercent,
    ceiling: 100,
  },
};

/** Whether a route's module parameter names a phone history page. */
export function isHistoryModule(value: string): value is PopoverCard {
  return Object.hasOwn(HISTORY_MODULES, value);
}

/** The desktop range presets offered in the phone's range control. */
export const PHONE_RANGES = RANGE_PRESETS.filter(({ ms }) =>
  [HOUR_MS, DAY_MS, 7 * DAY_MS, 30 * DAY_MS].includes(ms)
);

export interface HistoryRange {
  fromMs: number;
  toMs: number;
  fixed?: boolean;
}

/** Keep history and events on the same host-clock window while reading it. */
export function useHistoryRange(
  windowMs: number,
  offsetMs: number
): HistoryRange {
  const [wallMs, setWallMs] = useState(Date.now);
  useFocusedAppEffect(
    useCallback(() => {
      const now = Date.now();
      setWallMs((previous) =>
        Math.abs(now - previous) >= 1000 ? now : previous
      );
      const timer = setInterval(() => setWallMs(Date.now()), MINUTE_MS);
      return () => clearInterval(timer);
    }, [])
  );
  return useMemo(() => {
    const toMs = Math.floor(hostClock(offsetMs, wallMs)());
    return { fromMs: toMs - windowMs, toMs, fixed: false };
  }, [offsetMs, wallMs, windowMs]);
}

const HISTORY_CACHE_MS = 30_000;
const BUSY_ATTEMPTS = 3;
type PlotWidth = number | { columns: number } | null;

/** One reply for a chart's points, range statistics and optional module events. */
export function useHostHistory(
  host: HostId,
  selection: readonly SeriesSelector[],
  range: HistoryRange,
  width: PlotWidth,
  eventsFor: Module | null = null
) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    () =>
      AppState.currentState !== "inactive" &&
      AppState.currentState !== "background"
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);
  const { fromMs, toMs, fixed } = range;
  const measured = typeof width === "number" ? width : (width?.columns ?? 0);
  const ready = Number.isFinite(measured) && measured >= 1;
  const budget =
    typeof width === "number"
      ? Math.min(200, Math.max(30, Math.floor(width / 2.5)))
      : Math.floor(measured);
  const rolling = fixed === false;
  const query = useQuery({
    queryKey: historyKeys.hostHistory(
      host,
      selection,
      rolling ? toMs - fromMs : fromMs,
      rolling ? "now" : toMs,
      budget,
      eventsFor
    ),
    enabled: focused && foreground && ready,
    subscribed: focused && foreground && ready,
    staleTime: HISTORY_CACHE_MS,
    gcTime: HISTORY_CACHE_MS,
    retry: (failures, error) => {
      const kind = commandError(error)?.kind;
      return kind === "remote_busy"
        ? failures < BUSY_ATTEMPTS - 1
        : kind === "internal" && failures === 0;
    },
    retryDelay: 1000,
    queryFn: async ({ signal }) => {
      if (signal.aborted) throw new CancelledError();
      const page = await unwrap(
        transport.hostHistory({
          host,
          series: [...selection],
          from_ms: fromMs,
          to_ms: toMs,
          max_points: budget,
          events_for: eventsFor,
        })
      );
      return { range, page };
    },
  });
  const { data, isSuccess, isFetching, isStale, refetch } = query;
  // The rolling key keeps the previous reply on screen during a refresh and
  // lets a remount within the cache window reuse it.
  useEffect(() => {
    if (
      ready &&
      focused &&
      foreground &&
      rolling &&
      isSuccess &&
      isStale &&
      !isFetching &&
      Math.abs(toMs - data.range.toMs) >= HISTORY_CACHE_MS
    ) {
      void refetch({ cancelRefetch: false });
    }
  }, [
    data,
    focused,
    foreground,
    isFetching,
    isStale,
    isSuccess,
    ready,
    refetch,
    rolling,
    toMs,
  ]);
  return query;
}

/** Read a module's buckets and keep the reply's plot bounds during refresh. */
export function useModuleHistory(
  host: HostId,
  module: PopoverCard,
  range: HistoryRange,
  width: number | null
) {
  const keys = useMemo(
    () => HISTORY_MODULES[module].series.map(({ key }) => key),
    [module]
  );
  const selection = useMemo(
    () => keys.map((metric) => ({ metric, labels: [] })),
    [keys]
  );
  const query = useHostHistory(host, selection, range, width, module);
  const displayedRange = query.data?.range ?? range;
  const data = query.data?.page;
  const grid = useMemo(
    () =>
      data
        ? historyGrid(data, keys, displayedRange.fromMs, displayedRange.toMs)
        : null,
    [data, keys, displayedRange]
  );
  return { ...query, data, grid, displayedRange };
}

/** Project event rows from the shared reply. The chart presents its read state. */
export function useEvents(history: ReturnType<typeof useModuleHistory>) {
  const { data, grid: _grid, displayedRange: _range, ...query } = history;
  const events = data?.events;
  const rows = { ...query, isPending: false, isError: false, error: null };
  return history.isSuccess && events
    ? { ...rows, data: events, isSuccess: true as const }
    : { ...rows, data: events, isSuccess: false as const };
}

/** Current readings have their own subscription and do not depend on history. */
export function useModuleLiveValues(host: HostId, module: PopoverCard) {
  useHostLiveSubscription(host);
  return useHostLive(
    host,
    (state) =>
      HISTORY_MODULES[module].series.map(({ key }) =>
        state.stale ||
        state.connection !== "live" ||
        state.status?.paused ||
        state.status?.display_idle
          ? null
          : (state.held[key] ?? null)
      ),
    shallow
  );
}

/** Explain a failed history or events read using the store or connection error. */
export function historyReadError(
  error: unknown,
  what: "history" | "events",
  hostName = "this host"
) {
  const typed = commandError(error);
  if (typed?.kind === "remote_unsupported")
    return `Update StatGlass on ${hostName} to see ${what}`;
  if (typed?.kind === "remote_busy") return `StatGlass on ${hostName} is busy`;
  return (
    (typed && historyUnavailable(typed)?.message) ||
    remoteQueryText(error, what) ||
    `Couldn’t load ${what}. ${failureReason(error, "Please try again.")}`
  );
}
