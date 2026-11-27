/** Host history queries and the time windows used to display their replies. */
import { commandError } from "@core/command-error";
import type {
  Event,
  HostId,
  Module,
  SeriesSelector,
} from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { historyUnavailable } from "@core/history-state";
import { hostClock } from "@core/host-clock";
import type { PopoverCard } from "@core/popover/card-order";
import { historyKeys } from "@core/query-keys";
import { failureReason, remoteQueryText } from "@core/remote-errors";
import { MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { CancelledError, useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppActive, useFocusedAppEffect } from "./live";
import { usePhoneTransport } from "./transport-context";

/** Titles for the modules with a phone history page. */
export const MODULE_TITLES: Record<PopoverCard, string> = {
  cpu: "CPU",
  memory: "Memory",
  gpu: "GPU",
  power: "Power & Sensors",
  network: "Network",
  battery: "Battery",
};

/** Whether a route's module parameter names a phone history page. */
export function isHistoryModule(value: string): value is PopoverCard {
  return Object.hasOwn(MODULE_TITLES, value);
}

export type HistoryRange = {
  fromMs: number;
  toMs: number;
} & ({ rolling: false } | { rolling: true; offsetMs: number });

/** A window that follows the host's clock and carries its offset. */
export type RollingHistoryRange = Extract<HistoryRange, { rolling: true }>;

function rollingRange(
  windowMs: number,
  offsetMs: number,
  wallMs?: number
): RollingHistoryRange {
  const toMs = Math.floor(hostClock(offsetMs, wallMs)());
  return { fromMs: toMs - windowMs, toMs, rolling: true, offsetMs };
}

/** Keep history and events on the same host-clock window while reading it. */
export function useHistoryRange(
  windowMs: number,
  offsetMs: number
): RollingHistoryRange {
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

/** Refresh a range picked again while its reply is still fresh in the cache. */
export function useRefreshOnRangeChange(
  windowMs: number,
  query: ReturnType<typeof useHostHistory>
) {
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
}

/** The series and event source for a module's history read. */
export interface ModuleRead {
  /** The module whose events the reply carries. */
  module: Module;
  selection: readonly SeriesSelector[];
  /** The series keys the grid is built from; often a subset of the selection. */
  gridKeys: readonly string[];
}

function useEventsInRange(
  events: readonly Event[] | undefined,
  { fromMs, toMs }: HistoryRange
): readonly Event[] | undefined {
  // The host can start the read on an earlier tier boundary.
  return useMemo(
    () => events?.filter(({ ts_ms }) => ts_ms >= fromMs && ts_ms <= toMs),
    [events, fromMs, toMs]
  );
}

/**
 * Read a module's buckets, grid and in-range events.
 * @throws Outside PhoneTransportProvider, or before a transport is chosen.
 */
export function useModuleHistory(
  host: HostId,
  { module, selection, gridKeys }: ModuleRead,
  range: HistoryRange,
  width: PlotWidth,
  enabled: boolean
) {
  const query = useHostHistory(host, selection, range, width, module, enabled);
  useRefreshOnRangeChange(range.toMs - range.fromMs, query);
  const displayedRange = query.data?.range ?? range;
  const data = enabled ? query.data?.page : undefined;
  const grid = useMemo(
    () =>
      data
        ? historyGrid(
            data,
            gridKeys,
            displayedRange.fromMs,
            displayedRange.toMs
          )
        : null,
    [data, gridKeys, displayedRange]
  );
  const events = useEventsInRange(data?.events, displayedRange);
  return { ...query, data, grid, displayedRange, events };
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
