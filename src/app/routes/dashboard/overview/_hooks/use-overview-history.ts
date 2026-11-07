import type { Module } from "@core/generated/bindings";
import { historyKeys } from "@core/query-keys";
import { DAY_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useHostClock } from "~/lib/host-clock";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

/** Plan 4.5: the 24 h maxima refresh every 10 minutes. */
const REFRESH_MS = 10 * 60_000;

/**
 * 24 h maximum of `metric` (an unlabelled series), one `query_series_stats`
 * on mount, refreshed every 10 minutes. Undefined while loading or when
 * history is unavailable: Rust then answers from the engine's last 15
 * minutes alone, which is no 24 h maximum. Callers fall back to the bar's
 * floor.
 */
export function useMax24h(module: Module, metric: string): number | undefined {
  const clock = useHostClock();
  const transport = useTransport();
  const hostId = useHostId();
  const unavailable = useHistoryHealth().error?.kind === "history_unavailable";
  const { data } = useQuery({
    queryKey: historyKeys.maxima(hostId, module, metric),
    queryFn: async () => {
      const now = clock();
      const stats = await unwrap(
        transport.querySeriesStats(hostId, [metric], now - DAY_MS, now)
      );
      return stats.metrics[0]?.max ?? null;
    },
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
  return unavailable ? undefined : (data ?? undefined);
}

/**
 * When the Mac last woke, from Rust's `last_wake` (its sleep gaps of the
 * last week). Null when there is none in that span, or history is
 * unavailable.
 */
export function useLastWake(): number | null {
  const transport = useTransport();
  const hostId = useHostId();
  const { data } = useQuery({
    queryKey: historyKeys.lastWake(hostId),
    queryFn: () => unwrap(transport.lastWake(hostId)),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
  return data ?? null;
}
