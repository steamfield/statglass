import type { TimeRange } from "@core/brush";
import {
  type HistoricalUsageMetric,
  USAGE_HISTORY_MAX_RANGE_MS,
} from "@core/generated/types";
import { historyKeys, sameUsageWindow } from "@core/query-keys";
import { unwrap } from "@core/transport";
import {
  type QueryKey,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

interface PreviousQuery {
  queryKey: QueryKey;
  meta?: Record<string, unknown> | undefined;
}

/**
 * Whether the answer under `previous` may stand in while `next` loads in a
 * rolling view: `previous` was read for the rolling window too, over the
 * same span, and `sameUsageWindow` says it is the same view. A brushed
 * selection's answer never stands in.
 */
function rollingHold(
  rolling: boolean,
  previous: PreviousQuery | undefined,
  next: QueryKey
): boolean {
  return (
    rolling &&
    previous?.meta?.rolling === true &&
    sameUsageWindow(previous.queryKey, next)
  );
}

/** Fixed answers are cached until explicit refresh or history invalidation. Live
 * callers advance their bounds at the existing open-bucket edge, never at 1Hz.
 * Completeness cannot imply finality: late ownership can amend an older interval. */
export function useHistoricalUsage(
  range: TimeRange | null,
  by: HistoricalUsageMetric,
  {
    appNames = [],
    holdAcrossMetrics = false,
    rolling = false,
  }: {
    appNames?: readonly string[];
    /**
     * The range is the chart window ending at the open edge, so it moves
     * every 10 s: the last window's answer stays on screen while the next
     * one loads, so a table over it never empties.
     */
    rolling?: boolean;
    /**
     * Another metric over the same range keeps the last answer on screen
     * while it loads, so a table over it (and its selection) stays mounted.
     */
    holdAcrossMetrics?: boolean;
  } = {}
) {
  const transport = useTransport();
  const host = useHostId();
  const from = range?.fromMs ?? 0;
  const to = range?.toMs ?? 0;
  const sameRange = historyKeys.historicalUsageRange(host, from, to);
  const queryKey = historyKeys.historicalUsage(host, from, to, by, appNames);
  return useQuery({
    queryKey,
    meta: { rolling },
    placeholderData: (previous, previousQuery) =>
      (holdAcrossMetrics &&
        previousQuery !== undefined &&
        sameRange.every((part, i) => previousQuery.queryKey[i] === part)) ||
      rollingHold(rolling, previousQuery, queryKey)
        ? previous
        : undefined,
    queryFn: () =>
      unwrap(
        transport.queryHistoricalUsage({
          host,
          from_ms: from,
          to_ms: to,
          by,
          app_names: [...appNames],
        })
      ),
    enabled: range !== null && to - from <= USAGE_HISTORY_MAX_RANGE_MS,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** One app's recorded processes, paged; `rolling` as `useHistoricalUsage`. */
export function useHistoricalProcesses(
  range: TimeRange,
  by: HistoricalUsageMetric,
  appName: string,
  rolling = false
) {
  const transport = useTransport();
  const host = useHostId();
  const client = useQueryClient();
  const queryKey = historyKeys.usageProcesses(
    host,
    range.fromMs,
    range.toMs,
    by,
    appName
  );
  const query = useInfiniteQuery({
    queryKey,
    meta: { rolling },
    placeholderData: <T>(
      previous: T | undefined,
      previousQuery: PreviousQuery | undefined
    ) => (rollingHold(rolling, previousQuery, queryKey) ? previous : undefined),
    queryFn: ({ pageParam }) =>
      unwrap(
        transport.queryUsageProcesses({
          host,
          from_ms: range.fromMs,
          to_ms: range.toMs,
          by,
          app_name: appName,
          page_size: 100,
          cursor: pageParam,
        })
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return {
    ...query,
    restart: () => client.resetQueries({ queryKey, exact: true }),
  };
}
