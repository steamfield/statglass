/** Chart windows and accessible labels for live host cards. */
import { BRUSH_STEP_MS } from "@core/brush";
import {
  chartLabel,
  hasChartReading,
  shouldRefreshFigures,
} from "@core/chart-label";
import { formatPercent } from "@core/format";
import type { HostId } from "@core/generated/types";
import {
  gridIntervalMs,
  type HostLive,
  ringLoading,
  type SeriesWindow,
  seriesWindow,
} from "@core/live-state";
import { scaledWindowMs, windowLabel } from "@core/live-window";
import { MINUTE_MS } from "@core/time-grid";
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import type { Accent } from "@core/widget-models/tokens";
import { useMemo, useRef } from "react";
import { useHostLive } from "./live";
import { useNiceCeiling } from "./nice-ceiling";

interface CardSeriesWindow extends SeriesWindow {
  windowMs: number;
  loading: boolean;
  edgeMs: number | null;
}

function sameWindow(a: CardSeriesWindow, b: CardSeriesWindow) {
  return (
    a.edgeMs === b.edgeMs &&
    a.intervalMs === b.intervalMs &&
    a.windowMs === b.windowMs &&
    a.loading === b.loading &&
    a.values.length === b.values.length &&
    a.values.every((value, index) => Object.is(value, b.values[index]))
  );
}

/** A frame can change held readings or other series without changing this chart. */
function useCardSeriesWindow(host: HostId, key: string, baseMs: number) {
  const select = useMemo(() => {
    let cached: { state: HostLive; window: CardSeriesWindow } | undefined;
    return (state: HostLive): CardSeriesWindow => {
      const intervalMs = gridIntervalMs(state.status);
      const windowMs = scaledWindowMs(baseMs, intervalMs);
      const loading = ringLoading(state, windowMs);
      const edgeMs = state.lastTsMs;
      if (
        cached?.state.rowsVersion === state.rowsVersion &&
        cached.state.columns === state.columns &&
        cached.state.layouts === state.layouts &&
        cached.window.edgeMs === edgeMs &&
        cached.window.intervalMs === intervalMs &&
        cached.window.loading === loading
      ) {
        return cached.window;
      }
      const window = {
        ...seriesWindow(state, key, windowMs),
        windowMs,
        loading,
        edgeMs,
      };
      cached = { state, window };
      return window;
    };
  }, [key, baseMs]);
  return useHostLive(host, select, sameWindow);
}

function useLiveChartLabel(
  subject: string,
  windowMs: number,
  figure: string | undefined,
  scope: string,
  edgeMs: number | null
) {
  const key = `${scope}:${subject}:${windowMs}`;
  const now = figure === undefined ? null : `now ${figure}`;
  const stream = edgeMs === null ? null : { bucketMs: BRUSH_STEP_MS, edgeMs };
  const held = useRef({ key, now, stream });
  if (
    stream === null ||
    now === null ||
    held.current.key !== key ||
    !hasChartReading(held.current.now) ||
    shouldRefreshFigures(held.current.stream, stream)
  ) {
    held.current = { key, now, stream };
  }
  return chartLabel({ subject, spanMs: windowMs, now: held.current.now });
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
  now?: string | undefined;
  /** Plot height in points. */
  height: number;
  /** A fixed ceiling, such as 100 for a percentage. Omit it to autoscale. */
  yMax?: number;
  /** The minimum ceiling when autoscaling. Defaults to 10. */
  minCeiling?: number;
  /** Formats the ceiling in the series' units. Defaults to percent for CPU and GPU. */
  formatCeiling?: (ceiling: number) => string;
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
    formatCeiling = formatPercent,
    bare = false,
  }: CompactStreamOptions
): StreamAreaData | null {
  const { values, tEndMs, intervalMs, windowMs, edgeMs, loading } =
    useCardSeriesWindow(host, seriesKey, MINUTE_MS);
  const auto = useNiceCeiling(values, tEndMs, minCeiling, {
    intervalMs,
    scope: `${host}:${seriesKey}:${windowMs}:${minCeiling}`,
  });
  const ariaLabel = useLiveChartLabel(
    subject,
    windowMs,
    now,
    `${host}:${seriesKey}`,
    edgeMs
  );
  const ready = edgeMs !== null || loading;
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
              ceilingLabel: formatCeiling(ceiling),
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
      formatCeiling,
      windowMs,
    ]
  );
}

/** Prepare the upload and download bars and their held ceilings for a Network card. */
export function useNetworkBars(host: HostId): MirrorBarsData | null {
  const up = useCardSeriesWindow(host, "net.tx_total", 48_000);
  const down = useCardSeriesWindow(host, "net.rx_total", 48_000);
  const { windowMs, loading, edgeMs } = up;
  const upMax = useNiceCeiling(up.values, up.tEndMs, 100_000, {
    intervalMs: up.intervalMs,
    scope: `${host}:${windowMs}`,
  });
  const downMax = useNiceCeiling(down.values, down.tEndMs, 100_000, {
    intervalMs: down.intervalMs,
    scope: `${host}:${windowMs}`,
  });
  const ready = edgeMs !== null || loading;
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
            ariaLabel: chartLabel({
              subject: "Network: upload above the line, download below",
              spanMs: windowMs,
              now: null,
            }),
          }
        : null,
    [ready, loading, up, down, upMax, downMax, windowMs]
  );
}
