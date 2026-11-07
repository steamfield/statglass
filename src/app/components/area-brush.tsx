import { rangeFractions, rangeSlots, type TimeRange } from "@core/brush";
import { seriesRange } from "@core/chart-math";
import { gapExplanation } from "@core/history-state";
import type { ReactNode } from "react";
import {
  BrushOverlay,
  type BrushOverlayProps,
} from "~/components/brush-overlay";
import { useChartBrush } from "~/hooks/use-chart-brush";
import type { WindowSeries } from "~/hooks/use-window-series";
import { useBrushStoreOptional } from "~/stores/brush-store";
import type { GapSpan } from "~/widgets/gap-band";

export interface BrushWiring {
  /** The selection to veil the marks outside of, as plot fractions. */
  highlight: { left: number; width: number } | null;
  /** The `BrushOverlay`, wired to the newest elapsed edge and the gaps. */
  overlay: ReactNode;
}

const OFF: BrushWiring = { highlight: null, overlay: null };

/**
 * The brush for any chart over `[firstMs, firstMs + spanMs)` (D-089): the
 * selection's veil fractions and a `BrushOverlay` that stops at the newest
 * elapsed 10 s edge and explains the gap under the pointer. Bar, area and
 * canvas charts wire it the same way. Off when `enabled` is false, outside
 * a `BrushProvider`, or before the chart has a span. A bar chart passes
 * `barMs`, so the veil runs along bar edges and never cuts a bar wider than
 * a selection's 10 s bucket.
 */
export function useBrushOverlay({
  firstMs,
  spanMs,
  height,
  inset,
  barMs,
  gaps = [],
  enabled = true,
  onHoverTime,
}: {
  firstMs: number;
  spanMs: number;
  height: number;
  inset: number;
  /** Width of each bar, for a bar chart. */
  barMs?: number;
  gaps?: readonly GapSpan[] | undefined;
  enabled?: boolean;
  onHoverTime?: BrushOverlayProps["onHoverTime"];
}): BrushWiring {
  const provider = useBrushStoreOptional();
  const on = enabled && provider !== null;
  const { selected, elapsedEdge } = useChartBrush(on);
  if (!on || spanMs <= 0) return OFF;
  return {
    highlight: selected && veilFractions(selected, firstMs, spanMs, barMs),
    overlay: (
      <BrushOverlay
        firstMs={firstMs}
        spanMs={spanMs}
        selectableToMs={elapsedEdge ?? undefined}
        height={height}
        inset={inset}
        gapExplanationAt={(time) =>
          gapExplanation(
            gaps.find((gap) => gap.fromMs <= time && gap.toMs > time)
          )
        }
        {...(onHoverTime && { onHoverTime })}
      />
    ),
  };
}

/** The selection's veil fractions: exact, or widened to whole bars. */
function veilFractions(
  r: TimeRange,
  firstMs: number,
  spanMs: number,
  barMs: number | undefined
): { left: number; width: number } | null {
  if (barMs === undefined) return rangeFractions(r, firstMs, spanMs);
  const count = Math.round(spanMs / barMs);
  const { from, to } = rangeSlots(r, firstMs, barMs, count);
  return to > from ? { left: from / count, width: (to - from) / count } : null;
}

/**
 * The brush for a `StreamArea` (D-089, D-099): `useBrushOverlay` over the
 * series it draws. The plot runs from the first point to the last, so that
 * is the span the overlay maps the pointer onto. Read the series with
 * `useWindowSeries(keys, windowMs, { brush: true })`, so the points line up
 * with 10 s buckets.
 */
export function useAreaBrush(
  series: WindowSeries,
  height: number,
  enabled = true,
  gaps: readonly GapSpan[] = []
): BrushWiring {
  const n = Math.max(0, ...Object.values(series.values).map((v) => v.length));
  const drawn = series.tEndMs > 0 && n >= 2;
  const { fromMs, toMs } = drawn ? seriesRange(series) : { fromMs: 0, toMs: 0 };
  return useBrushOverlay({
    firstMs: fromMs,
    spanMs: toMs - fromMs,
    height,
    inset: 0,
    gaps,
    enabled,
  });
}
