import { RANGE_PRESETS } from "@core/chart-range";
import { commandError } from "@core/command-error";
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatWatts,
} from "@core/format";
import type { HostId } from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { historyUnavailable } from "@core/history-state";
import { hostClock } from "@core/host-clock";
import type { PopoverCard } from "@core/popover/card-order";
import { historyKeys, sameHost, sameModuleSeries } from "@core/query-keys";
import { failureReason, remoteQueryText } from "@core/remote-errors";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import type { Accent } from "@core/widget-models/tokens";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useFocusedAppEffect } from "./live";
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
  offsetMs: number,
  offlineEndMs: number | null
): HistoryRange {
  const [wallMs, setWallMs] = useState(Date.now);
  useFocusedAppEffect(
    useCallback(() => {
      if (offlineEndMs !== null) return undefined;
      const now = Date.now();
      setWallMs((previous) =>
        Math.abs(now - previous) >= 1000 ? now : previous
      );
      const timer = setInterval(() => setWallMs(Date.now()), MINUTE_MS);
      return () => clearInterval(timer);
    }, [offlineEndMs])
  );
  return useMemo(() => {
    const toMs = offlineEndMs ?? Math.floor(hostClock(offsetMs, wallMs)());
    return { fromMs: toMs - windowMs, toMs, fixed: offlineEndMs !== null };
  }, [offlineEndMs, offsetMs, wallMs, windowMs]);
}

const HISTORY_POINTS = 240;

/** Read a module's buckets and hold the previous plot bounds during a rolling refresh. */
export function useModuleHistory(
  host: HostId,
  module: PopoverCard,
  range: HistoryRange
) {
  const transport = usePhoneTransport();
  const { fromMs, toMs, fixed } = range;
  const keys = useMemo(
    () => HISTORY_MODULES[module].series.map(({ key }) => key),
    [module]
  );
  const queryKey = historyKeys.moduleSeries(
    host,
    keys,
    toMs - fromMs,
    toMs,
    HISTORY_POINTS,
    fixed
  );
  const query = useQuery({
    queryKey,
    queryFn: async () => ({
      range,
      page: await unwrap(
        transport.hostHistory({
          host,
          series: keys.map((metric) => ({ metric, labels: [] })),
          from_ms: fromMs,
          to_ms: toMs,
          max_points: HISTORY_POINTS,
          events_for: null,
        })
      ),
    }),
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameModuleSeries(previousQuery.queryKey, queryKey)
        ? previous
        : undefined,
  });
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

/** Read events for the selected window, keeping rows while the same span advances. */
export function useEvents(host: HostId, fromMs: number, toMs: number) {
  const transport = usePhoneTransport();
  const queryKey = historyKeys.events(host, toMs - fromMs, toMs);
  const windowKey = queryKey.slice(0, -1);
  return useQuery({
    queryKey,
    queryFn: async () => {
      // This stub has no module input. The shared module reply will supply the events.
      const page = await unwrap(
        transport.hostHistory({
          host,
          series: [{ metric: "cpu.total", labels: [] }],
          from_ms: fromMs,
          to_ms: toMs,
          max_points: 1,
          events_for: "cpu",
        })
      );
      return page.events;
    },
    placeholderData: (previous, previousQuery) =>
      previousQuery &&
      sameHost(previousQuery.queryKey, queryKey) &&
      previousQuery.queryKey.length === queryKey.length &&
      windowKey.every((part, index) => previousQuery.queryKey[index] === part)
        ? previous
        : undefined,
  });
}

/** Explain a failed history or events read using the store or connection error. */
export function historyReadError(error: unknown, what: "history" | "events") {
  const typed = commandError(error);
  return (
    (typed && historyUnavailable(typed)?.message) ||
    remoteQueryText(error, what) ||
    `Couldn’t load ${what}. ${failureReason(error, "Please try again.")}`
  );
}
