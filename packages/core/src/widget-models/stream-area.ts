/**
 * The stream-area model: the live area/line chart's data contract and the
 * geometry both apps draw from it (paths in a 1000-wide viewBox, gap-edge
 * dots, the dash offset that keeps dashes on the data while it scrolls).
 */
import { splitGaps } from "@core/chart-math";
import {
  annotationsModel,
  type ChartAnnotationData,
  type PlacedAnnotation,
} from "@core/widget-models/chart-annotation";
import {
  type GapSpan,
  gapBandsModel,
  type PlacedGapBand,
} from "@core/widget-models/gap-band";
import type { Accent, ColorRef } from "@core/widget-models/tokens";
import { scaleLinear } from "d3-scale";
import { area, line } from "d3-shape";

/** Width of the drawing in viewBox units; each renderer stretches it to its box. */
export const STREAM_VIEWBOX_W = 1000;
/** Line width in px when a series sets no `weight`. */
export const DEFAULT_LINE_WEIGHT = 1.5;
const DASH = [3, 2] as const;
const DASH_PERIOD = DASH[0] + DASH[1];

function seriesColors(step: StreamAreaSeries["step"]) {
  return {
    stroke: Object.freeze({ kind: "accent", step, ink: true } as const),
    fill: Object.freeze({ kind: "accent", step, ink: false } as const),
  };
}

const COLORS = {
  1: seriesColors(1),
  2: seriesColors(2),
  3: seriesColors(3),
  4: seriesColors(4),
};

/** One series of a {@link StreamAreaData}, drawn back to front. */
export interface StreamAreaSeries {
  key: string;
  /** `null` is a gap: the line breaks there. */
  values: (number | null)[];
  /** Ramp step of the accent; step 1 gets the area fill. */
  step: 1 | 2 | 3 | 4;
  /**
   * Draw the area under the line (default). `false` is a bare line, as
   * for per-app lines over a total.
   */
  fill?: boolean;
  /** Hollow dots on the edges that border a gap (default true). */
  edges?: boolean;
  /** A dashed line, to tell apart two lines on the same ramp step. */
  dash?: boolean;
  /** Line width in px (default 1.5). */
  weight?: number;
  /** Opacity of the line and its area (default 1), for focus emphasis. */
  opacity?: number;
}

/**
 * Data contract for the live area/line chart (design-system.md inventory),
 * shared by the desktop widget and the phone twin.
 */
export interface StreamAreaData {
  /** History for this window is still arriving: draw the frame and the loading mark, no data. */
  loading?: boolean;
  /** Series drawn back to front. `null` is a gap: the line breaks there. */
  series: StreamAreaSeries[];
  /** Timestamp of the last value (ms epoch). Values are `intervalMs` apart. */
  tEndMs: number;
  intervalMs: number;
  /** Y ceiling, already snapped (fixed 100, or a nice ceiling from the hook). */
  yMax: number;
  accent: Accent;
  height: number;
  ariaLabel?: string;
  /** Corner label for the ceiling ("40%"), top left. */
  ceilingLabel?: string;
  /** Corner label for the window ("60s"), bottom right. */
  windowLabel?: string;
  /** Horizontal gridlines at these y values (the baseline is always drawn). */
  gridlines?: readonly number[];
  /** Y tick labels in a 32 px gutter on the left (100, 75, 50, 25). */
  yTicks?: readonly { value: number; label: string }[];
  /** Width of the y tick gutter, px (default 32; 48 for byte labels). */
  gutter?: number | undefined;
  /** X tick labels spread under the plot, oldest first ("−60s" … "now"). */
  xTicks?: readonly string[];
  /**
   * Labelled gaps (sleep, paused) drawn as hatched bands over the plot;
   * the parts outside the window are clipped.
   */
  gaps?: readonly GapSpan[];
  /**
   * A selected span as fractions of the plot width; the plot outside it is
   * veiled. Null or absent: nothing is selected.
   */
  highlight?: { left: number; width: number } | null;
  /**
   * Labelled markers at the top of the plot (power spikes, D-083); ones
   * outside the window are dropped.
   */
  annotations?: readonly ChartAnnotationData[];
}

/** One drawn series: its paths, edge dots and token colors. */
export interface StreamAreaSeriesModel {
  key: string;
  opacity: number;
  filled: boolean;
  linePath: string;
  areaPath: string;
  edges: readonly { xFrac: number; y: number }[];
  stroke: ColorRef;
  fill: ColorRef;
  dash: readonly [number, number] | null;
  weight: number;
}

/** Everything a renderer needs to draw one frame of the chart. */
export interface StreamAreaModel {
  height: number;
  slots: number;
  windowMs: number;
  dashOffset: number;
  series: readonly StreamAreaSeriesModel[];
  gaps: readonly PlacedGapBand[];
  annotations: readonly PlacedAnnotation[];
  ceilingLabel: string | null;
  windowLabel: string | null;
}

interface Point {
  x: number;
  y: number;
}

/** The chart's geometry for a plot `widthPx` wide (0 until measured). */
export function streamAreaModel(
  data: StreamAreaData,
  {
    widthPx,
    annotationScale = 1,
  }: { widthPx: number; annotationScale?: number }
) {
  const { height, intervalMs, loading, series, tEndMs, yMax } = data;
  let slots = 2;
  for (const s of series) slots = Math.max(slots, s.values.length);
  const windowMs = (slots - 1) * intervalMs;
  // Move the dash pattern with the data while the path starts at the left edge.
  const dashOffset =
    widthPx > 0 && intervalMs > 0
      ? (Math.round(tEndMs / intervalMs) * (widthPx / (slots - 1))) %
        DASH_PERIOD
      : 0;

  return {
    height,
    slots,
    windowMs,
    dashOffset,
    series: loading ? [] : drawSeries(series, slots, yMax, height),
    gaps:
      !loading && data.gaps?.length && tEndMs > 0
        ? gapBandsModel(data.gaps, tEndMs - windowMs, tEndMs)
        : [],
    annotations: loading
      ? []
      : annotationsModel(
          data.annotations,
          tEndMs,
          windowMs,
          widthPx,
          annotationScale
        ),
    ceilingLabel: data.ceilingLabel ?? null,
    windowLabel: data.windowLabel ?? null,
  } satisfies StreamAreaModel;
}

function drawSeries(
  series: readonly StreamAreaSeries[],
  slots: number,
  yMax: number,
  height: number
) {
  const x = scaleLinear()
    .domain([0, slots - 1])
    .range([0, STREAM_VIEWBOX_W]);
  const y = scaleLinear()
    .domain([0, yMax > 0 ? yMax : 1])
    .range([height - 1, 1])
    .clamp(true);
  const lineGen = line<Point>()
    .x((p) => p.x)
    .y((p) => p.y);
  const areaGen = area<Point>()
    .x((p) => p.x)
    .y0(height)
    .y1((p) => p.y);

  return series.map((s) => {
    // Right-align shorter series so their last value still ends at "now".
    const offset = slots - s.values.length;
    const runs = splitGaps(s.values).map((run) =>
      run.values.map((v, j) => ({ x: x(offset + run.start + j), y: y(v) }))
    );
    const filled = s.fill !== false;
    const lines = runs.filter((pts) => pts.length > 1);
    const linePath = lines.map((pts) => lineGen(pts) ?? "").join("");
    const areaPath = filled
      ? lines.map((pts) => areaGen(pts) ?? "").join("")
      : "";
    const edges: { xFrac: number; y: number }[] = [];
    (s.edges !== false ? runs : []).forEach((pts, k) => {
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (first && (pts.length === 1 || k > 0)) {
        edges.push({ xFrac: first.x / STREAM_VIEWBOX_W, y: first.y });
      }
      if (last && pts.length > 1 && k < runs.length - 1) {
        edges.push({ xFrac: last.x / STREAM_VIEWBOX_W, y: last.y });
      }
    });
    return {
      key: s.key,
      opacity: s.opacity ?? 1,
      filled,
      linePath,
      areaPath,
      edges,
      ...COLORS[s.step],
      dash: s.dash ? DASH : null,
      weight: s.weight ?? DEFAULT_LINE_WEIGHT,
    } satisfies StreamAreaSeriesModel;
  });
}
