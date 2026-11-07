import { rangeSlots } from "@core/brush";
import { gapExplanation } from "@core/history-state";
import { useRef } from "react";
import { BrushOverlay } from "~/components/brush-overlay";
import { PLOT_INSET } from "~/components/charts/layout";
import { MirrorHover } from "~/components/mirror-hover";
import { useChartBrush } from "~/hooks/use-chart-brush";
import { useNiceCeiling } from "~/hooks/use-nice-ceiling";
import { GapBands, type GapSpan } from "~/widgets/gap-band";
import type { Accent } from "~/widgets/lib/accent";
import { historyTicks } from "~/widgets/lib/chart-labels";
import { FIELD_LABEL } from "~/widgets/lib/classes";
import { MirrorBars } from "~/widgets/mirror-bars";
import { WindowTicks } from "~/widgets/window-ticks";

/**
 * The accessible name of a mirrored chart, one wording everywhere:
 * "Network: upload above the line, download below, last 15 minutes".
 */
export function mirrorAriaLabel({
  subject,
  upLabel,
  downLabel,
  span,
  brush = false,
}: {
  subject: string;
  upLabel: string;
  downLabel: string;
  span: string;
  brush?: boolean;
}): string {
  const label = `${subject}: ${upLabel.toLowerCase()} above the line, ${downLabel.toLowerCase()} below, ${span}.`;
  return brush ? `${label} Drag to select a range.` : label;
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
  root
    .querySelectorAll<HTMLElement>("[data-mirror-crosshair]")
    .forEach((el) => {
      el.hidden = !valid;
      if (valid)
        el.style.left = `calc(${PLOT_INSET}px + (100% - ${PLOT_INSET}px) * ${(index + 0.5) / count})`;
    });
}

export interface MirrorChartProps {
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
  /** Range selection (D-089); needs a `BrushProvider` above. */
  brush: boolean;
  /**
   * Hover contract. Absent: the chart's own readout (`MirrorHover`). Given
   * (with `brush`): the owner paints its own readout from the hovered time
   * and moves the crosshairs with `paintMirrorCrosshairs`, so stacked plots
   * share one crosshair and one tooltip without re-rendering React.
   */
  onHoverTime?: ((time: number | null) => void) | undefined;
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
  const { selected, elapsedEdge } = useChartBrush(brush);
  const slots = selected
    ? rangeSlots(selected, firstMs, bucketMs, count)
    : null;
  // A selection scrolled off the chart dims nothing.
  const highlight = slots && slots.to > slots.from ? slots : null;
  const plotRef = useRef<HTMLDivElement>(null);
  const height = upHeight + downHeight + 1;
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
        <div ref={plotRef}>
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
            highlight={highlight}
            ariaLabel={mirrorAriaLabel({
              subject,
              upLabel,
              downLabel,
              span,
              brush,
            })}
          />
        </div>
        {brush && !pending && (
          <BrushOverlay
            firstMs={firstMs}
            spanMs={count * bucketMs}
            selectableToMs={elapsedEdge ?? undefined}
            height={height}
            gapExplanationAt={(time) =>
              gapExplanation(
                gaps?.find((gap) => gap.fromMs <= time && gap.toMs > time)
              )
            }
            {...(onHoverTime && { onHoverTime })}
          />
        )}
        {gaps && gaps.length > 0 && !pending && (
          <div
            className="pointer-events-none absolute top-0 right-0"
            style={{ left: PLOT_INSET, height }}
          >
            <GapBands gaps={gaps} rangeFromMs={firstMs} rangeToMs={endMs} />
          </div>
        )}
        {pending ? null : onHoverTime ? (
          <div
            data-mirror-crosshair
            hidden
            aria-hidden
            className="pointer-events-none absolute top-0 w-px bg-fg-subtle"
            style={{ height }}
          />
        ) : (
          <MirrorHover
            plotRef={plotRef}
            inset={PLOT_INSET}
            height={height}
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
            column={!brush}
            live={live}
            dateLabels={dateLabels}
          />
        )}
      </div>
      {axis && (
        <WindowTicks
          ticks={historyTicks(firstMs, endMs, live, 5)}
          style={{ paddingLeft: PLOT_INSET }}
        />
      )}
    </div>
  );
}
