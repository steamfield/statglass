import { useRef } from "react";
import { useBrushOverlay } from "~/components/area-brush";
import {
  CrosshairLine,
  paintCrosshairs,
  plotLeft,
} from "~/components/charts/crosshair-line";
import { PLOT_INSET } from "~/components/charts/layout";
import { MirrorHover } from "~/components/mirror-hover";
import { useChartLabel } from "~/hooks/use-chart-label";
import { useNiceCeiling } from "~/hooks/use-nice-ceiling";
import { ChartSelectionVeil } from "~/widgets/chart-frame";
import { GapBands, type GapSpan } from "~/widgets/gap-band";
import type { Accent } from "~/widgets/lib/accent";
import { historyTicks, windowTicks } from "~/widgets/lib/chart-labels";
import { FIELD_LABEL } from "~/widgets/lib/classes";
import { MirrorBars } from "~/widgets/mirror-bars";
import { WindowTicks } from "~/widgets/window-ticks";

/**
 * The subject of a mirrored chart's accessible name, one wording everywhere:
 * "Network: upload above the line, download below". `useChartLabel` adds
 * the span.
 */
export function mirrorSubject({
  subject,
  upLabel,
  downLabel,
}: {
  subject: string;
  upLabel: string;
  downLabel: string;
}): string {
  return `${subject}: ${upLabel.toLowerCase()} above the line, ${downLabel.toLowerCase()} below`;
}

/**
 * Moves the crosshair of every `MirrorChart` under `root` to the centre of
 * bar `index` (of `count`), or hides them all: one crosshair across sibling
 * plots, written to the DOM so a pointer move re-renders nothing.
 */
export function paintMirrorCrosshairs(
  root: ParentNode,
  index: number | null,
  count: number
): void {
  const valid = index !== null && index >= 0 && index < count;
  paintCrosshairs(
    root,
    valid ? plotLeft((index + 0.5) / count, PLOT_INSET) : null
  );
}

/**
 * Range selection (D-089; needs a `BrushProvider` above) and the hover
 * contract. Without `onHoverTime` the chart shows its own readout
 * (`MirrorHover`). With it the owner paints its own readout from the hovered
 * time and moves the crosshairs with `paintMirrorCrosshairs`, so stacked
 * plots share one crosshair and one tooltip without re-rendering React. The
 * hovered time comes from the brush overlay, so it needs `brush`.
 */
export type MirrorChartBrush =
  | {
      brush: true;
      onHoverTime?: ((time: number | null) => void) | undefined;
    }
  | { brush: false; onHoverTime?: never };

export type MirrorChartProps = MirrorChartData & MirrorChartBrush;

interface MirrorChartData {
  /** Per bar, oldest first; `null` is a gap. Same length as `down`. */
  up: readonly (number | null)[];
  down: readonly (number | null)[];
  /** Start of the first bar, and each bar's width. */
  firstMs: number;
  bucketMs: number;
  /** The chart window: changing it refits the ceilings at once. */
  windowMs: number;
  /** The range's fixed end, or null while it follows now (ticks say "now"). */
  fixedEndMs: number | null;
  /** What the chart shows, leading its accessible name ("Network"). */
  subject: string;
  /** "Upload", "Read"; drawn with ↑ and ↓ beside each side's ceiling. */
  upLabel: string;
  downLabel: string;
  /** "last 15 minutes", "selected dates". */
  span: string;
  /** Formats a ceiling and a hovered value ("40 MB/s"). */
  format: (v: number) => string;
  /** Smallest ceiling either side autoscales to, in the series' unit. */
  minCeiling: number;
  accent: Accent;
  upHeight: number;
  downHeight: number;
  /** Labelled gaps drawn as hatched bands over the bars. */
  gaps?: readonly GapSpan[] | undefined;
  /** Hover times carry dates (multi-day or fixed ranges). */
  dateLabels: boolean;
  /** The x tick row under the plot (default on; off for an upper sibling). */
  axis?: boolean;
  /** No bucket yet: the empty frame, without brush, gaps or hover. */
  pending?: boolean;
}

/**
 * A mirrored up/down bar chart (Network, Disk I/O): each side autoscales on
 * its own with the 60 s shrink hysteresis and states its ceiling in the
 * label column, so a small upload next to a large download stays readable.
 * It owns the selection dimming, brush, gap bands and x ticks; the owner
 * reads the buckets and decides the hover readout.
 */
export function MirrorChart({
  up,
  down,
  firstMs,
  bucketMs,
  windowMs,
  fixedEndMs,
  subject,
  upLabel,
  downLabel,
  span,
  format,
  minCeiling,
  accent,
  upHeight,
  downHeight,
  gaps,
  brush,
  onHoverTime,
  dateLabels,
  axis = true,
  pending = false,
}: MirrorChartProps) {
  const count = Math.max(1, up.length);
  const lastMs = firstMs + (count - 1) * bucketMs;
  const endMs = firstMs + count * bucketMs;
  const scope = { endMs: fixedEndMs, intervalMs: bucketMs };
  const upMax = useNiceCeiling(up, lastMs, minCeiling, windowMs, scope);
  const downMax = useNiceCeiling(down, lastMs, minCeiling, windowMs, scope);
  const plotRef = useRef<HTMLDivElement>(null);
  const height = upHeight + downHeight + 1;
  const ariaLabel = useChartLabel({
    subject: mirrorSubject({ subject, upLabel, downLabel }),
    span,
    brushable: brush,
  });
  const selection = useBrushOverlay({
    firstMs,
    spanMs: count * bucketMs,
    height,
    inset: PLOT_INSET,
    gaps,
    enabled: brush && !pending,
    onHoverTime,
  });
  const live = fixedEndMs === null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative" style={{ paddingLeft: PLOT_INSET }}>
        <div
          aria-hidden
          className="absolute top-0 left-0 flex w-22 flex-col justify-between"
          style={{ height }}
        >
          <span className={FIELD_LABEL}>
            ↑ {upLabel}
            <span className="block normal-case tracking-normal">
              {format(upMax)}
            </span>
          </span>
          <span className={FIELD_LABEL}>
            <span className="block normal-case tracking-normal">
              {format(downMax)}
            </span>
            ↓ {downLabel}
          </span>
        </div>
        <div ref={plotRef} className="relative">
          <MirrorBars
            up={up}
            down={down}
            intervalMs={bucketMs}
            tEndMs={lastMs}
            upMax={upMax}
            downMax={downMax}
            upHeight={upHeight}
            downHeight={downHeight}
            accent={accent}
            ariaLabel={ariaLabel}
          />
          <ChartSelectionVeil highlight={selection.highlight} />
        </div>
        {selection.overlay}
        {gaps && gaps.length > 0 && !pending && (
          <div
            className="pointer-events-none absolute top-0 right-0"
            style={{ left: PLOT_INSET, height }}
          >
            {/* Centred: a caption straddling the bottom edge would cover
                the tick row just under the plot. */}
            <GapBands
              gaps={gaps}
              rangeFromMs={firstMs}
              rangeToMs={endMs}
              labelPosition="center"
            />
          </div>
        )}
        {!pending && <CrosshairLine paint height={height} />}
        {!pending && !onHoverTime && (
          <MirrorHover
            plotRef={plotRef}
            inset={PLOT_INSET}
            count={count}
            firstMs={firstMs}
            bucketMs={bucketMs}
            up={up}
            down={down}
            upLabel={upLabel}
            downLabel={downLabel}
            gaps={gaps}
            format={format}
            accent={accent}
            live={live}
            dateLabels={dateLabels}
          />
        )}
      </div>
      {axis && (
        <WindowTicks
          // Live ticks name the window: when its start is off a bucket edge
          // the bars run up to a bucket past it.
          ticks={
            live
              ? windowTicks(windowMs, 5)
              : historyTicks(firstMs, endMs, false, 5)
          }
          style={{ paddingLeft: PLOT_INSET }}
        />
      )}
    </div>
  );
}
