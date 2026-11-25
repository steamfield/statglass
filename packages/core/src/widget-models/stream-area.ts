/**
 * The stream-area model: the live area/line chart's data contract and the
 * geometry both apps draw from it (paths in a 1000-wide viewBox, gap-edge
 * dots, the dash offset that keeps dashes on the data while it scrolls).
 */
import type {
  AnnotationModel,
  ChartAnnotationData,
} from "@core/widget-models/chart-annotation";
import type { GapBandModel, GapSpan } from "@core/widget-models/gap-band";
import type { Accent, ColorRef } from "@core/widget-models/tokens";

/** Width of the drawing in viewBox units; each renderer stretches it to its box. */
export const STREAM_VIEWBOX_W = 1000;

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
  gaps: readonly GapBandModel[];
  annotations: readonly AnnotationModel[];
  ceilingLabel: string | null;
  windowLabel: string | null;
}

/**
 * The chart's geometry for a plot `widthPx` wide (0 until measured).
 * @throws {Error} until the chart lane implements it
 */
export function streamAreaModel(
  _data: StreamAreaData,
  _size: { widthPx: number }
): StreamAreaModel {
  throw new Error("not implemented");
}
