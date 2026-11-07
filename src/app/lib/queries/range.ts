import { BRUSH_STEP_MS, type TimeRange } from "@core/brush";
import type { HostId } from "@core/generated/bindings";
import { sameHost } from "@core/query-keys";
import type { Transport } from "@core/transport";
import { type QueryKey, useQuery } from "@tanstack/react-query";
import { holdWhile } from "~/lib/queries/hold";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

interface QueryLike<T> {
  state: { data: T | undefined; status: string; dataUpdateCount: number };
}

/**
 * How long to wait before reading an open answer again. `reads` counts
 * answers under the current key (TanStack's `dataUpdateCount`).
 */
export type RangePoll<T> = (data: T | undefined, reads: number) => number;

/**
 * Freshness for a query over a time range (D-089, D-099): an answer that
 * `isFinal` is read once; one that reaches time still being measured reads
 * again every `pollMs` (10 s by default) until it is final; a failed one
 * waits for the key to move. `keepPrevious` marks the query as one whose
 * answer may stand in while its key moves (the whole-window view, whose key
 * advances every 10 s).
 */
export function rangeQueryOptions<T>(
  isFinal: (data: T | undefined) => boolean,
  keepPrevious: boolean,
  pollMs: RangePoll<T> = () => BRUSH_STEP_MS
) {
  return {
    staleTime: (q: QueryLike<T>) =>
      isFinal(q.state.data) ? Number.POSITIVE_INFINITY : 0,
    refetchInterval: (q: QueryLike<T>) =>
      q.state.status === "error" || isFinal(q.state.data)
        ? false
        : pollMs(q.state.data, q.state.dataUpdateCount),
    meta: { rolling: keepPrevious },
  };
}

/**
 * A history command over `range`, with `rangeQueryOptions` freshness.
 * Disabled while `range` is null. `isFinal` gets the range's end, for
 * answers that are final once they reach it. With `keepPrevious`, the last
 * rolling answer holds while the key moves, when it covered a window of
 * the same span (a 1 h total never stands in under a 24 h label) and `same`
 * (default: the same host) says the previous key is the same view.
 */
export function useRangeQuery<T>(
  range: TimeRange | null,
  {
    key,
    fetch,
    isFinal,
    keepPrevious = false,
    pollMs,
    same = sameHost,
  }: {
    key: (hostId: HostId, fromMs: number, toMs: number) => QueryKey;
    fetch: (
      transport: Transport,
      hostId: HostId,
      fromMs: number,
      toMs: number
    ) => Promise<T>;
    isFinal: (data: T | undefined, toMs: number) => boolean;
    keepPrevious?: boolean;
    pollMs?: RangePoll<T> | undefined;
    same?: (previous: QueryKey, next: QueryKey) => boolean;
  }
) {
  const transport = useTransport();
  const hostId = useHostId();
  const fromMs = range?.fromMs ?? 0;
  const toMs = range?.toMs ?? 0;
  const queryKey = key(hostId, fromMs, toMs);
  const spanMs = toMs - fromMs;
  const hold = holdWhile(queryKey, same);
  const options = rangeQueryOptions<T>(
    (d) => isFinal(d, toMs),
    keepPrevious,
    pollMs
  );
  return useQuery({
    queryKey,
    queryFn: () => fetch(transport, hostId, fromMs, toMs),
    enabled: range !== null,
    ...options,
    meta: { ...options.meta, spanMs },
    // Only a rolling answer stands in for a rolling view, never a selection's.
    placeholderData: (previous, query) =>
      keepPrevious &&
      query?.meta?.rolling === true &&
      query.meta.spanMs === spanMs
        ? hold(previous, query)
        : undefined,
  });
}
