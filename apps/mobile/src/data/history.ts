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
import { historyKeys } from "@core/query-keys";
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

export function isHistoryModule(value: string): value is PopoverCard {
  return Object.hasOwn(HISTORY_MODULES, value);
}

export const PHONE_RANGES = RANGE_PRESETS.filter(({ ms }) =>
  [HOUR_MS, DAY_MS, 7 * DAY_MS, 30 * DAY_MS].includes(ms)
);

export interface HistoryRange {
  fromMs: number;
  toMs: number;
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
    return { fromMs: toMs - windowMs, toMs };
  }, [offlineEndMs, offsetMs, wallMs, windowMs]);
}

const HISTORY_POINTS = 240;

export function useModuleHistory(
  host: HostId,
  module: PopoverCard,
  { fromMs, toMs }: HistoryRange
) {
  const transport = usePhoneTransport();
  const keys = useMemo(
    () => HISTORY_MODULES[module].series.map(({ key }) => key),
    [module]
  );
  const query = useQuery({
    queryKey: historyKeys.moduleSeries(
      host,
      keys,
      toMs - fromMs,
      toMs,
      HISTORY_POINTS,
      true
    ),
    queryFn: () =>
      unwrap(
        transport.queryHistory({
          host,
          selectors: keys.map((metric) => ({ metric, labels: [] })),
          from_ms: fromMs,
          to_ms: toMs,
          tier: "auto",
          max_points: HISTORY_POINTS,
        })
      ),
  });
  const grid = useMemo(
    () => (query.data ? historyGrid(query.data, keys, fromMs, toMs) : null),
    [query.data, keys, fromMs, toMs]
  );
  return { ...query, grid };
}

export function useEvents(host: HostId, fromMs: number, toMs: number) {
  const transport = usePhoneTransport();
  return useQuery({
    queryKey: historyKeys.events(host, toMs - fromMs, toMs),
    queryFn: () => unwrap(transport.queryEvents(host, fromMs, toMs)),
  });
}

export function historyReadError(error: unknown, what: "history" | "events") {
  const typed = commandError(error);
  return (
    (typed && historyUnavailable(typed)?.message) ||
    remoteQueryText(error, what) ||
    `Couldn’t load ${what}. ${failureReason(error, "Please try again.")}`
  );
}
