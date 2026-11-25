import { RANGE_PRESETS } from "@core/chart-range";
import { commandError } from "@core/command-error";
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatWatts,
} from "@core/format";
import {
  type HostId,
  type Module,
  RETENTION_DAYS,
  type SeriesSelector,
} from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { historyUnavailable } from "@core/history-state";
import { hostClock } from "@core/host-clock";
import {
  BATTERY_HERO,
  CPU_HERO,
  GPU_HERO,
  NETWORK_HERO,
  POWER_HERO,
} from "@core/module-hero";
import type { PhoneRemoteHostStatus } from "@core/phone-connection";
import type { PopoverCard } from "@core/popover/card-order";
import { historyKeys } from "@core/query-keys";
import { failureReason, remoteQueryText } from "@core/remote-errors";
import { DAY_MS, MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import type { Accent } from "@core/widget-models/tokens";
import { CancelledError, useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shallow } from "zustand/shallow";
import { useFocusDemand } from "./demand";
import {
  useAppActive,
  useConnection,
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
    series: CPU_HERO.keys.map((key) => ({
      key,
      label: key === "cpu.total" ? "Total" : "System",
    })),
    format: formatPercent,
    ceiling: 100,
  },
  memory: {
    title: "Memory",
    accent: "mem",
    series: [
      { key: "mem.used", label: "Memory used" },
      { key: "mem.cached", label: "Cached files" },
    ],
    format: formatBytes,
  },
  gpu: {
    title: "GPU",
    accent: "gpu",
    series: GPU_HERO.keys.map((key) => ({ key, label: "Utilization" })),
    format: formatPercent,
    ceiling: 100,
  },
  power: {
    title: "Power & Sensors",
    accent: "power",
    series: POWER_HERO.keys.map((key) => ({ key, label: "System power" })),
    format: formatWatts,
  },
  network: {
    title: "Network",
    accent: "net",
    series: [
      { key: NETWORK_HERO.chart.downKey, label: NETWORK_HERO.chart.downLabel },
      { key: NETWORK_HERO.chart.upKey, label: NETWORK_HERO.chart.upLabel },
    ],
    format: formatRate,
  },
  battery: {
    title: "Battery",
    accent: "battery",
    series: [{ key: BATTERY_HERO.keys[0], label: "Battery charge" }],
    format: formatPercent,
    ceiling: 100,
  },
};

/** Whether a route's module parameter names a phone history page. */
export function isHistoryModule(value: string): value is PopoverCard {
  return Object.hasOwn(HISTORY_MODULES, value);
}

// The phone does not receive per-host retention. Use the shortest setting.
const PHONE_RETENTION_MS = Math.min(...RETENTION_DAYS) * DAY_MS;
export const PHONE_RANGES = RANGE_PRESETS.filter(
  ({ ms }) => ms <= PHONE_RETENTION_MS
);

export type HistoryRange = {
  fromMs: number;
  toMs: number;
} & ({ rolling: false } | { rolling: true; offsetMs: number });

function rollingRange(
  windowMs: number,
  offsetMs: number,
  wallMs?: number
): HistoryRange {
  const toMs = Math.floor(hostClock(offsetMs, wallMs)());
  return { fromMs: toMs - windowMs, toMs, rolling: true, offsetMs };
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
  return useMemo(
    () => rollingRange(windowMs, offsetMs, wallMs),
    [offsetMs, wallMs, windowMs]
  );
}

const HISTORY_CACHE_MS = 30_000;
const BUSY_ATTEMPTS = 3;
export type PlotWidth = number | { columns: number } | null;

export function historyPointBudget(width: number) {
  return Math.min(200, Math.max(30, Math.floor(width / 2.5)));
}

/** One reply for a chart's points, range statistics and optional module events. */
export function useHostHistory(
  host: HostId,
  selection: readonly SeriesSelector[],
  range: HistoryRange,
  width: PlotWidth,
  eventsFor: Module | null = null,
  connected = true,
  refresh = true
) {
  const transport = usePhoneTransport();
  const focused = useIsFocused();
  const foreground = useAppActive();
  const { fromMs, toMs, rolling } = range;
  const windowMs = toMs - fromMs;
  const measured = typeof width === "number" ? width : (width?.columns ?? 0);
  const ready = Number.isFinite(measured) && measured >= 1;
  const budget =
    typeof width === "number"
      ? historyPointBudget(width)
      : Math.floor(measured);
  const enabled = connected && focused && foreground && ready;
  const query = useQuery({
    queryKey: historyKeys.hostHistory(
      host,
      selection,
      rolling ? { windowMs } : { fromMs, toMs },
      budget,
      eventsFor
    ),
    enabled,
    subscribed: enabled,
    staleTime: HISTORY_CACHE_MS,
    refetchOnMount: refresh,
    gcTime: HISTORY_CACHE_MS,
    retry: (failures, error) => {
      const kind = commandError(error)?.kind;
      return kind === "remote_busy"
        ? failures < BUSY_ATTEMPTS - 1
        : failures === 0 &&
            (kind === "internal" ||
              (!refresh && kind === "remote_unreachable"));
    },
    retryDelay: 1000,
    queryFn: async ({ signal }) => {
      // Reading the signal lets TanStack cancel and revert this fetch when
      // the last observer leaves, even though the transport keeps running.
      if (signal.aborted) throw new CancelledError();
      // Re-enabling can start a fetch before the focus effect updates its clock.
      const bounds = range.rolling
        ? rollingRange(windowMs, range.offsetMs)
        : range;
      const page = await unwrap(
        transport.hostHistory({
          host,
          series: [...selection],
          from_ms: bounds.fromMs,
          to_ms: bounds.toMs,
          max_points: budget,
          events_for: eventsFor,
        })
      );
      return { range: bounds, page };
    },
  });
  const { data, isSuccess, isFetching, isStale, refetch } = query;
  // The rolling key keeps the previous reply on screen during a refresh and
  // lets a remount within the cache window reuse it.
  useEffect(() => {
    if (
      enabled &&
      refresh &&
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
    enabled,
    isFetching,
    isStale,
    isSuccess,
    refetch,
    refresh,
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
  width: PlotWidth,
  connected: boolean
) {
  useFocusDemand(host, "full");
  const keys = useMemo(
    () => HISTORY_MODULES[module].series.map(({ key }) => key),
    [module]
  );
  const selection = useMemo(
    () => keys.map((metric) => ({ metric, labels: [] })),
    [keys]
  );
  const query = useHostHistory(
    host,
    selection,
    range,
    width,
    module,
    connected
  );
  const windowMs = range.toMs - range.fromMs;
  const previousWindow = useRef(windowMs);
  const { isEnabled, isFetching, isSuccess, refetch } = query;
  useEffect(() => {
    const changed = previousWindow.current !== windowMs;
    previousWindow.current = windowMs;
    // A new cache entry fetches by itself. Refresh a freshly cached range
    // when the user returns to it, while still reusing it on a remount.
    if (changed && isEnabled && isSuccess && !isFetching) {
      void refetch({ cancelRefetch: false });
    }
  }, [isEnabled, isFetching, isSuccess, refetch, windowMs]);
  const displayedRange = query.data?.range ?? range;
  const data = connected ? query.data?.page : undefined;
  const grid = useMemo(
    () =>
      data
        ? historyGrid(data, keys, displayedRange.fromMs, displayedRange.toMs)
        : null,
    [data, keys, displayedRange]
  );
  return { ...query, data, grid, displayedRange };
}

/** Current readings have their own subscription and do not depend on history. */
export function useModuleLiveValues(
  host: HostId,
  module: PopoverCard,
  remote: PhoneRemoteHostStatus | undefined
) {
  useHostLiveSubscription(host);
  const live = useConnection(host, remote, null).state === "live";
  return useHostLive(
    host,
    (state) =>
      HISTORY_MODULES[module].series.map(({ key }) =>
        live ? (state.held[key] ?? null) : null
      ),
    shallow
  );
}

/** Explain a failed history read using the store or connection error. */
export function historyReadError(error: unknown, hostName = "this host") {
  const typed = commandError(error);
  if (typed?.kind === "remote_unsupported")
    return `Update StatGlass on ${hostName} to see history`;
  if (typed?.kind === "remote_busy") return `StatGlass on ${hostName} is busy`;
  return (
    (typed && historyUnavailable(typed)?.message) ||
    remoteQueryText(error, "history") ||
    `Couldn’t load history. ${failureReason(error, "Please try again.")}`
  );
}
