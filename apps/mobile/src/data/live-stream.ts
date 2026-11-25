import { type CeilingState, nextCeiling } from "@core/chart-math";
import type { HostId } from "@core/generated/types";
import {
  gridIntervalMs,
  ringLoading,
  type SeriesWindow,
  seriesWindow,
  type WindowState,
} from "@core/live-state";
import { scaledWindowMs, spanWords, windowLabel } from "@core/live-window";
import { MINUTE_MS } from "@core/time-grid";
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import type { Accent } from "@core/widget-models/tokens";
import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useHostLive } from "./live";

function useLiveWindow(host: HostId, baseMs: number) {
  const state = useHostLive(
    host,
    (s) => ({
      columns: s.columns,
      layouts: s.layouts,
      lastTsMs: s.lastTsMs,
      status: s.status,
      rowsVersion: s.rowsVersion,
      connection: s.connection,
      historyPending: s.historyPending,
    }),
    shallow
  );
  const windowMs = scaledWindowMs(baseMs, gridIntervalMs(state.status));
  return { state, windowMs, loading: ringLoading(state, windowMs) };
}

function useSeriesWindow(state: WindowState, key: string, windowMs: number) {
  const previous = useRef<SeriesWindow | null>(null);
  return useMemo(() => {
    const next = seriesWindow(state, key, windowMs);
    const cached = previous.current;
    if (
      cached?.tEndMs === next.tEndMs &&
      cached.intervalMs === next.intervalMs &&
      shallow(cached.values, next.values)
    ) {
      return cached;
    }
    previous.current = next;
    return next;
  }, [state, key, windowMs]);
}

function useCeiling(
  values: readonly (number | null)[],
  tsMs: number,
  intervalMs: number,
  scope: string,
  floor: number
) {
  const held = useRef<{ scope: string; value: CeilingState } | null>(null);
  const max = values.reduce<number | null>(
    (peak, value) => (value === null ? peak : Math.max(peak ?? value, value)),
    null
  );
  const previous = held.current?.scope === scope ? held.current.value : null;
  const value = nextCeiling(previous, max, tsMs, {
    minCeiling: floor,
    maxTickGapMs: Math.max(10_000, 2 * intervalMs),
  });
  held.current = { scope, value };
  return value.ceiling;
}

function useLiveChartLabel(
  subject: string,
  windowMs: number,
  now: string | undefined,
  scope: string
) {
  const readAt = performance.now();
  const key = `${scope}:${subject}:${windowMs}`;
  const label = useRef({ key, now, readAt });
  if (
    label.current.key !== key ||
    !/[0-9]/.test(label.current.now ?? "") ||
    readAt - label.current.readAt >= 10_000
  ) {
    label.current = { key, now, readAt };
  }
  const figure = label.current.now;
  return `${subject}, ${spanWords(windowMs, null)}${figure === undefined ? "" : `, now ${figure}`}`;
}

/** Display options for a single series on a live card. */
export interface CompactStreamOptions {
  /** The live series key to draw, such as `gpu.util`. */
  seriesKey: string;
  /** The module accent used for the chart marks. */
  accent: Accent;
  /** The subject of the accessible name, such as GPU. */
  subject: string;
  /** The formatted current figure. Omit it to leave the figure out of the name. */
  now?: string;
  /** Plot height in points. */
  height: number;
  /** A fixed ceiling, such as 100 for a percentage. Omit it to autoscale. */
  yMax?: number;
  /** The minimum ceiling when autoscaling. Defaults to 10. */
  minCeiling?: number;
  /** Hide chart captions and the midline. */
  bare?: boolean;
}

/** Prepare a compact chart over the last minute, scaled to the host's frame interval. */
export function useCompactStream(
  host: HostId,
  {
    seriesKey,
    accent,
    subject,
    now,
    height,
    yMax,
    minCeiling = 10,
    bare = false,
  }: CompactStreamOptions
): StreamAreaData | null {
  const { state, windowMs, loading } = useLiveWindow(host, MINUTE_MS);
  const { values, tEndMs, intervalMs } = useSeriesWindow(
    state,
    seriesKey,
    windowMs
  );
  const auto = useCeiling(
    values,
    tEndMs,
    intervalMs,
    `${host}:${seriesKey}:${windowMs}:${minCeiling}`,
    minCeiling
  );
  const ariaLabel = useLiveChartLabel(
    subject,
    windowMs,
    now,
    `${host}:${seriesKey}`
  );
  const ready = state.lastTsMs !== null || loading;
  const ceiling = yMax ?? auto;
  return useMemo<StreamAreaData | null>(
    () =>
      ready
        ? {
            loading,
            series: [{ key: seriesKey, values, step: 1 }],
            tEndMs,
            intervalMs,
            yMax: ceiling,
            accent,
            height,
            ariaLabel,
            gridlines: bare ? [] : [ceiling / 2],
            ...(!bare && {
              ceilingLabel: `${ceiling}%`,
              windowLabel: windowLabel(windowMs),
            }),
          }
        : null,
    [
      ready,
      loading,
      seriesKey,
      values,
      tEndMs,
      intervalMs,
      ceiling,
      accent,
      height,
      ariaLabel,
      bare,
      windowMs,
    ]
  );
}

/** Prepare the upload and download bars and their held ceilings for a Network card. */
export function useNetworkBars(host: HostId): MirrorBarsData | null {
  const { state, windowMs, loading } = useLiveWindow(host, 48_000);
  const up = useSeriesWindow(state, "net.tx_total", windowMs);
  const down = useSeriesWindow(state, "net.rx_total", windowMs);
  const upMax = useCeiling(
    up.values,
    up.tEndMs,
    up.intervalMs,
    `${host}:${windowMs}`,
    100_000
  );
  const downMax = useCeiling(
    down.values,
    down.tEndMs,
    down.intervalMs,
    `${host}:${windowMs}`,
    100_000
  );
  const ready = state.lastTsMs !== null || loading;
  return useMemo<MirrorBarsData | null>(
    () =>
      ready
        ? {
            loading,
            up: up.values,
            down: down.values,
            intervalMs: up.intervalMs,
            tEndMs: up.tEndMs,
            upMax,
            downMax,
            accent: "net",
            ariaLabel: `Network upload and download, ${spanWords(windowMs, null)}`,
          }
        : null,
    [ready, loading, up, down, upMax, downMax, windowMs]
  );
}
