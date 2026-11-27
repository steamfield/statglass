/** Chart windows and accessible labels for live host cards. */
import { BRUSH_STEP_MS } from "@core/brush";
import {
  chartLabel,
  hasChartReading,
  shouldRefreshFigures,
} from "@core/chart-label";
import { formatPercent } from "@core/format";
import type { HostId } from "@core/generated/types";
import { windowLabel } from "@core/live-window";
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import type { Accent } from "@core/widget-models/tokens";
import { useMemo, useRef } from "react";
import { useCardWindow } from "./card-window";
import { useNiceCeiling } from "./nice-ceiling";
import { usePhoneSettings } from "./phone-settings";

const STREAM_SLOTS = 60;
const NETWORK_SLOTS = 48;
const NETWORK_KEYS = ["net.tx_total", "net.rx_total"];
const EMPTY_VALUES: (number | null)[] = [];

/** VoiceOver hears that a scanning chart has nothing to describe yet. */
function loadingLabel(label: string, loading: boolean) {
  return loading ? `${label} Loading.` : label;
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

/** Prepare a compact chart over the saved chart window. */
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
): StreamAreaData {
  const windowMs = usePhoneSettings((s) => s.chartWindowMs);
  const keys = useMemo(() => [seriesKey], [seriesKey]);
  const {
    values: [values = EMPTY_VALUES],
    tEndMs,
    bucketMs,
    intervalMs,
    edgeMs,
    loading,
  } = useCardWindow(host, keys, windowMs, STREAM_SLOTS);
  // The ceiling decays on the 1 Hz edge, not the bucket boundary.
  const auto = useNiceCeiling(values, edgeMs ?? tEndMs, minCeiling, {
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
  const ceiling = yMax ?? auto;
  return useMemo<StreamAreaData>(
    () => ({
      loading,
      series: [{ key: seriesKey, values, step: 1 }],
      tEndMs,
      intervalMs: bucketMs,
      yMax: ceiling,
      accent,
      height,
      ariaLabel: loadingLabel(ariaLabel, loading),
      gridlines: bare ? [] : [ceiling / 2],
      ...(!bare && {
        ceilingLabel: formatCeiling(ceiling),
        windowLabel: windowLabel(windowMs),
      }),
    }),
    [
      loading,
      seriesKey,
      values,
      tEndMs,
      bucketMs,
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
export function useNetworkBars(host: HostId): MirrorBarsData {
  const windowMs = usePhoneSettings((s) => s.chartWindowMs);
  const {
    values: [up = EMPTY_VALUES, down = EMPTY_VALUES],
    tEndMs,
    intervalMs,
    bucketMs,
    edgeMs,
    loading,
  } = useCardWindow(host, NETWORK_KEYS, windowMs, NETWORK_SLOTS);
  const upMax = useNiceCeiling(up, edgeMs ?? tEndMs, 100_000, {
    intervalMs,
    scope: `${host}:${windowMs}`,
  });
  const downMax = useNiceCeiling(down, edgeMs ?? tEndMs, 100_000, {
    intervalMs,
    scope: `${host}:${windowMs}`,
  });
  return useMemo<MirrorBarsData>(
    () => ({
      loading,
      up,
      down,
      intervalMs: bucketMs,
      tEndMs,
      upMax,
      downMax,
      accent: "net",
      ariaLabel: loadingLabel(
        chartLabel({
          subject: "Network: upload above the line, download below",
          spanMs: windowMs,
          now: null,
        }),
        loading
      ),
    }),
    [loading, up, down, bucketMs, tEndMs, upMax, downMax, windowMs]
  );
}
