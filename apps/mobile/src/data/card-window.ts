/** Live and stored samples on the host cards' compact chart grid. */
import type { HostId } from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import {
  gridIntervalMs,
  ringLoading,
  visitWindow,
  windowSlots,
} from "@core/live-state";
import { useMemo } from "react";
import { type HistoryRange, useHistoryRange, useHostHistory } from "./history";
import { useHostStatus } from "./hosts";
import {
  awaitingFirstData,
  type PhoneLive,
  subscribing,
  useHostLive,
} from "./live";

type HistoryGrid = ReturnType<typeof historyGrid>;
type Values = (number | null)[];
type BucketBounds = {
  bucketMs: number;
  tEndMs: number;
  firstRingMs: number | null;
};

/** Use history at the midpoint of each bucket entirely before the ring. */
export function stitchCardWindow(
  key: string,
  ring: Values,
  history: HistoryGrid | null,
  { bucketMs, tEndMs, firstRingMs }: BucketBounds
): Values {
  const stored = history?.values[key];
  if (!history || !stored) return ring;
  const firstStoredMs = history.endMs - (stored.length - 1) * history.bucketMs;
  return ring.map((value, index) => {
    const endMs = tEndMs - (ring.length - 1 - index) * bucketMs;
    if (firstRingMs !== null && endMs >= firstRingMs) return value;
    const midpoint = endMs - bucketMs / 2;
    return (
      stored[Math.floor((midpoint - firstStoredMs) / history.bucketMs)] ?? null
    );
  });
}

function ringBuckets(
  state: PhoneLive,
  key: string,
  windowMs: number,
  slots: number,
  intervalMs: number,
  bucketMs: number
): Values {
  const sourceLast = windowSlots(windowMs, intervalMs) - 1;
  const sums = new Float64Array(slots);
  const counts = new Uint32Array(slots);
  // Bucket bounds are open on the left and closed on the right, like visitWindow.
  visitWindow(state, key, windowMs, {
    put(slot, value) {
      const bucket =
        slots - 1 - Math.floor(((sourceLast - slot) * intervalMs) / bucketMs);
      if (bucket < 0) return;
      sums[bucket] = (sums[bucket] ?? 0) + value;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    },
  });
  return Array.from(counts, (count, index) =>
    count ? (sums[index] ?? 0) / count : null
  );
}

type RingWindow = {
  edgeMs: number | null;
  firstRingMs: number | null;
  bucketMs: number;
  slots: number;
  intervalMs: number;
  loading: boolean;
  connected: boolean;
  paused: boolean;
  values: Values[];
};

function sameRing(a: RingWindow, b: RingWindow) {
  return (
    a.edgeMs === b.edgeMs &&
    a.firstRingMs === b.firstRingMs &&
    a.bucketMs === b.bucketMs &&
    a.intervalMs === b.intervalMs &&
    a.loading === b.loading &&
    a.connected === b.connected &&
    a.paused === b.paused &&
    a.values.length === b.values.length &&
    a.values.every(
      (values, key) =>
        values.length === b.values[key]?.length &&
        values.every((value, slot) => Object.is(value, b.values[key]?.[slot]))
    )
  );
}

function useRingWindow(
  host: HostId,
  keys: readonly string[],
  windowMs: number,
  slots: number
) {
  const select = useMemo(() => {
    let cached: { state: PhoneLive; window: RingWindow } | undefined;
    return (state: PhoneLive): RingWindow => {
      const intervalMs = gridIntervalMs(state.status);
      const bucketMs = Math.max(intervalMs, windowMs / slots);
      const bucketCount = Math.min(slots, Math.ceil(windowMs / bucketMs));
      const edgeMs = state.lastTsMs;
      const subscribed = subscribing(state);
      const paused =
        state.status?.paused === true || state.status?.display_idle === true;
      const connected =
        subscribed &&
        state.stream !== null &&
        !state.stale &&
        (state.connection === "live" || paused);
      const loading =
        (subscribed && ringLoading(state, windowMs)) ||
        awaitingFirstData(state);
      if (
        cached?.state.rowsVersion === state.rowsVersion &&
        cached.state.columns === state.columns &&
        cached.state.layouts === state.layouts &&
        cached.window.edgeMs === edgeMs &&
        cached.window.intervalMs === intervalMs &&
        cached.window.loading === loading &&
        cached.window.connected === connected &&
        cached.window.paused === paused
      ) {
        return cached.window;
      }
      const window = {
        edgeMs,
        firstRingMs: state.columns.firstTsMs(),
        intervalMs,
        bucketMs,
        slots: bucketCount,
        loading,
        connected,
        paused,
        values: keys.map((key) =>
          ringBuckets(state, key, windowMs, bucketCount, intervalMs, bucketMs)
        ),
      };
      cached = { state, window };
      return window;
    };
  }, [keys, windowMs, slots]);
  return useHostLive(host, select, sameRing);
}

/** Stitch older history onto the live grid, in the order of the requested keys. */
export function useCardWindow(
  host: HostId,
  keys: readonly string[],
  windowMs: number,
  slots: number
) {
  const ring = useRingWindow(host, keys, windowMs, slots);
  const { edgeMs, firstRingMs, bucketMs, paused } = ring;
  const needsHistory =
    edgeMs === null ? paused : (firstRingMs ?? Infinity) > edgeMs - windowMs;
  const ready = ring.connected && !ring.loading && needsHistory;
  const { data: remote, isLoading: readingStatus } = useHostStatus(host, ready);
  const rolling = useHistoryRange(
    windowMs,
    remote?.status.clock_offset_ms ?? 0
  );
  // A paused plot with a live edge stays at its last sample.
  const range: HistoryRange =
    paused && edgeMs !== null
      ? { fromMs: edgeMs - windowMs, toMs: edgeMs, rolling: false }
      : rolling;
  const selection = useMemo(
    () => keys.map((metric) => ({ metric, labels: [] })),
    [keys]
  );
  const { data, isError, isLoading } = useHostHistory(
    host,
    selection,
    range,
    { columns: ring.slots },
    null,
    ready && (remote === null || remote?.status.state === "connected")
  );
  const answer = needsHistory && !isError ? data : undefined;
  const grid = useMemo(
    () =>
      answer
        ? historyGrid(answer.page, keys, answer.range.fromMs, answer.range.toMs)
        : null,
    [answer, keys]
  );
  const tEndMs = edgeMs ?? answer?.range.toMs ?? 0;
  const values = useMemo(
    () =>
      ring.values.map((values, index) =>
        stitchCardWindow(keys[index] ?? "", values, grid, {
          bucketMs,
          tEndMs,
          firstRingMs,
        })
      ),
    [ring.values, keys, grid, bucketMs, tEndMs, firstRingMs]
  );
  return {
    values,
    bucketMs,
    intervalMs: ring.intervalMs,
    edgeMs,
    tEndMs,
    loading: ring.loading || (ready && (readingStatus || isLoading)),
  };
}
