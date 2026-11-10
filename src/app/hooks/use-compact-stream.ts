import { spanWords, windowLabel } from "@core/live-window";
import { MINUTE_MS } from "@core/time-grid";
import { useChartLabel } from "~/hooks/use-chart-label";
import { useNiceCeiling } from "~/hooks/use-nice-ceiling";
import { useShownRingLoading } from "~/hooks/use-ring";
import { useScaledWindow } from "~/hooks/use-scaled-window";
import { useSeriesWindow } from "~/stores/live-selectors";
import type { Accent } from "~/widgets/lib/accent";
import type { StreamAreaProps } from "~/widgets/stream-area";

export interface CompactStreamOptions {
  /** The one series drawn, as a live series key ("gpu.util"). */
  seriesKey: string;
  accent: Accent;
  /** The accessible name's subject ("GPU"). */
  subject: string;
  /** The figure now, formatted ("34%"); absent leaves it out of the name. */
  now?: string | undefined;
  height: number;
  /** A fixed ceiling (100 for a percentage of capacity); absent autoscales. */
  yMax?: number;
  /** Smallest ceiling an autoscaled chart shrinks to (default 10). */
  minCeiling?: number;
  /** The compact popover row: no corner labels or midline. */
  bare?: boolean;
}

/**
 * The compact live stream on a popover or Overview card: one percentage
 * series over the last minute (stretched at slower intervals), the ceiling
 * top left, the window bottom right and a midline, and a 10 s-throttled
 * accessible name.
 * Returns `StreamArea` props, so a render-only card can take them as data.
 */
export function useCompactStream({
  seriesKey,
  accent,
  subject,
  now,
  height,
  yMax,
  minCeiling = 10,
  bare = false,
}: CompactStreamOptions): StreamAreaProps {
  const windowMs = useScaledWindow(MINUTE_MS);
  const history = useSeriesWindow(seriesKey, windowMs);
  const loading = useShownRingLoading(windowMs);
  const auto = useNiceCeiling(
    history.values,
    history.tEndMs,
    minCeiling,
    windowMs
  );
  const ceiling = yMax ?? auto;
  const ariaLabel = useChartLabel({
    subject,
    span: spanWords(windowMs, null),
    now: now === undefined ? undefined : `now ${now}`,
  });
  return {
    loading,
    series: [{ key: seriesKey, values: history.values, step: 1 }],
    tEndMs: history.tEndMs,
    intervalMs: history.intervalMs,
    yMax: ceiling,
    accent,
    height,
    ariaLabel,
    gridlines: bare ? [] : [ceiling / 2],
    ...(!bare && {
      ceilingLabel: `${ceiling}%`,
      windowLabel: windowLabel(windowMs),
    }),
  };
}
