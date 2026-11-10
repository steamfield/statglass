import { brushBucketMs } from "@core/brush";
import { spanWords } from "@core/live-window";
import { DAY_MS } from "@core/time-grid";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import {
  MirrorChart,
  type MirrorChartProps,
} from "~/components/charts/mirror-chart";
import { useGridInterval } from "~/hooks/use-grid-interval";
import { useModuleBuckets } from "~/hooks/use-module-buckets";
import { useModuleEnd } from "~/hooks/use-module-end";
import type { GapSpan } from "~/widgets/gap-band";
import type { Accent } from "~/widgets/lib/accent";

/** Bars across the chart: one per interval up to this, then wider buckets. */
const MAX_BARS = 120;

/**
 * Bucket width and count for a mirrored chart over `windowMs`: one bar per
 * sample for short windows, at most `maxBars` bars otherwise, each the
 * average of its bucket.
 */
export function mirrorBuckets(
  windowMs: number,
  intervalMs: number,
  brush = false,
  maxBars = MAX_BARS
): { bucketMs: number; count: number } {
  const samples = Math.max(1, Math.round(windowMs / intervalMs));
  const per = Math.max(1, Math.ceil(samples / maxBars));
  const bucketMs = brush
    ? brushBucketMs(per * intervalMs, intervalMs)
    : per * intervalMs;
  return { bucketMs, count: Math.max(1, Math.round(windowMs / bucketMs)) };
}

export interface LiveMirrorChartProps
  extends Pick<MirrorChartProps, "hover" | "ticks" | "inset"> {
  /**
   * Most bars drawn (default 120). A narrow card needs fewer: each bar
   * keeps a 2 px gap, so 120 bars in a 220 px plot have no width left.
   */
  maxBars?: number;
  /**
   * Series drawn above the axis (upload, read). Pages pass a Rust total
   * (`net.tx_total`, D-092), so the chart never adds interfaces itself.
   */
  upKey: string;
  /** Series drawn below the axis (download, write). */
  downKey: string;
  /** What the chart shows, leading its accessible name ("Network"). */
  subject: string;
  /** "Upload", "Read". */
  upLabel: string;
  downLabel: string;
  windowMs: number;
  accent: Accent;
  /** Formats a ceiling for the side labels ("40 MB/s"). */
  format: (v: number) => string;
  /** Smallest ceiling either side autoscales to, in the series' unit. */
  minCeiling: number;
  upHeight?: number;
  downHeight?: number;
  /** Labelled gaps drawn as hatched bands over the bars. */
  gaps?: readonly GapSpan[];
  /**
   * Time-range selection (D-089): needs a `BrushProvider` above.
   * Bars then use widths that divide 10 s (5 s at 5m, 10 s at 15m), so a
   * selection snapped to 10 s buckets lines up with them.
   */
  brush?: boolean;
}

/**
 * Module-page mirrored chart (plan 4.11, 4.12): `MirrorChart` fed from the
 * module range's buckets, with the history loading line above it.
 */
export function LiveMirrorChart({
  upKey,
  downKey,
  subject,
  upLabel,
  downLabel,
  windowMs,
  accent,
  format,
  minCeiling,
  upHeight = 72,
  downHeight = 120,
  gaps,
  brush = false,
  hover,
  ticks,
  inset,
  maxBars,
}: LiveMirrorChartProps) {
  const intervalMs = useGridInterval();
  const { bucketMs: requestedBucketMs, count: requestedCount } = mirrorBuckets(
    windowMs,
    intervalMs,
    brush,
    maxBars
  );
  const fixedEnd = useModuleEnd();
  const { values, endMs, bucketMs, loading, ringLoading, error } =
    useModuleBuckets(
      [upKey, downKey],
      requestedBucketMs,
      requestedCount,
      windowMs
    );
  const count = values[upKey]?.length ?? Math.ceil(windowMs / bucketMs);
  const pick = (key: string) =>
    Array.from({ length: count }, (_, i) => values[key]?.[i] ?? null);

  return (
    <div className="flex flex-col gap-1.5">
      <ChartHistoryStatus quiet loading={loading} error={error} />
      <MirrorChart
        loading={loading === true || ringLoading}
        up={pick(upKey)}
        down={pick(downKey)}
        firstMs={(endMs ?? 0) - (count - 1) * bucketMs}
        bucketMs={bucketMs}
        windowMs={windowMs}
        fixedEndMs={fixedEnd}
        subject={subject}
        upLabel={upLabel}
        downLabel={downLabel}
        span={spanWords(windowMs, fixedEnd)}
        format={format}
        minCeiling={minCeiling}
        accent={accent}
        upHeight={upHeight}
        downHeight={downHeight}
        gaps={gaps}
        brush={brush}
        hover={hover}
        ticks={ticks}
        inset={inset}
        dateLabels={fixedEnd !== null || windowMs >= DAY_MS}
        pending={endMs === null}
      />
    </div>
  );
}
