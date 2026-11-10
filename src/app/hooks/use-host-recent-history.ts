import { historyGrid } from "@core/history-grid";
import { gapBands } from "@core/history-state";
import { CLOCK_STEP_THRESHOLD_MS, hostClock } from "@core/host-clock";
import { historyKeys, sameHost } from "@core/query-keys";
import { MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useHostSelection } from "~/lib/host-selection";
import { holdWhile } from "~/lib/queries/hold";
import { useTransport } from "~/lib/transport-context";

const KEYS = ["cpu.total", "mem.used"];
const WINDOW_MS = 10 * MINUTE_MS;

/** Read mirrors directly: cards never open a remote detail subscription. */
export function useHostRecentHistory(hostId: string, offsetMs = 0) {
  const transport = useTransport();
  const cache = useQueryClient();
  const selected = useHostSelection()?.selected;
  const queryKey = historyKeys.recent(hostId, WINDOW_MS);
  const clock = useRef<() => number>(hostClock(offsetMs));
  const previousClock = useRef({ hostId, offsetMs });
  useLayoutEffect(() => {
    clock.current = hostClock(offsetMs);
  }, [offsetMs]);
  useEffect(() => {
    const previous = previousClock.current;
    previousClock.current = { hostId, offsetMs };
    if (
      hostId !== selected &&
      previous.hostId === hostId &&
      Math.abs(previous.offsetMs - offsetMs) >= CLOCK_STEP_THRESHOLD_MS
    )
      void cache.invalidateQueries(
        { queryKey: historyKeys.recent(hostId, WINDOW_MS) },
        { cancelRefetch: false }
      );
  }, [cache, hostId, offsetMs, selected]);
  const query = useQuery({
    queryKey,
    placeholderData: holdWhile(queryKey, sameHost),
    queryFn: async () => {
      const toMs = clock.current();
      const fromMs = toMs - WINDOW_MS;
      const page = await unwrap(
        transport.queryHistory({
          host: hostId,
          selectors: KEYS.map((metric) => ({ metric, labels: [] })),
          from_ms: fromMs,
          to_ms: toMs,
          tier: "s10",
          max_points: 61,
        })
      );
      return { page, fromMs, toMs };
    },
    refetchInterval: 10_000,
  });
  const data = query.data;
  const history = useMemo(() => {
    if (!data) return null;
    const { page, fromMs, toMs } = data;
    const grid = historyGrid(page, KEYS, fromMs, toMs);
    const gaps = (module: "cpu" | "memory") =>
      gapBands(page.gaps, fromMs, toMs, { module }).map((gap) => ({
        ...gap,
        showCaption: false,
      }));
    return { ...grid, cpuGaps: gaps("cpu"), memoryGaps: gaps("memory") };
  }, [data]);
  return { history, query };
}
