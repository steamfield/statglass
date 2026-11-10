import { historyGrid } from "@core/history-grid";
import { gapBands } from "@core/history-state";
import { historyKeys, sameHost } from "@core/query-keys";
import { MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { holdWhile } from "~/lib/queries/hold";
import { useTransport } from "~/lib/transport-context";

const KEYS = ["cpu.total", "mem.used"];
const WINDOW_MS = 10 * MINUTE_MS;

/** Read mirrors directly: cards never open a remote detail subscription. */
export function useHostRecentHistory(hostId: string, offsetMs = 0) {
  const transport = useTransport();
  const queryKey = historyKeys.recent(hostId, offsetMs);
  const query = useQuery({
    queryKey,
    placeholderData: holdWhile(queryKey, sameHost),
    queryFn: async () => {
      const toMs = Date.now() + offsetMs;
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
