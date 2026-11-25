/**
 * The chart-annotation model: which labelled markers fall inside a chart's
 * window, and the row and position the shared marker layout gives each.
 */
import { layoutMarkers } from "@core/chart-math";

/** Estimated width of one chart caption character at text scale 1. */
export const CHART_CAPTION_CHAR_WIDTH_PX = 6;

/** A labelled marker on a chart (power spikes, D-083); JSON-serializable. */
export interface ChartAnnotationData {
  /** When the annotated moment happened (ms epoch); the chart positions it. */
  tsMs: number;
  /** "ANE 1.4 W · Photos face analysis". */
  label: string;
  /**
   * `marker`: a 20 px vertical rule then the label (power chart).
   * `pill`: a bordered label on the card surface (battery chart).
   */
  variant?: "marker" | "pill";
  /**
   * `end` puts the marker after the label, for a box anchored by its right
   * edge so a label near the plot's right edge doesn't run past it.
   */
  align?: "start" | "end";
}

/** One placed marker: its x as a fraction of the plot and its stacking row. */
export interface AnnotationModel {
  key: string;
  xFrac: number;
  row: number;
  label: string;
  tone: string;
}

/** The fitted label box, including the side anchored at the marker. */
export interface PlacedAnnotation extends AnnotationModel {
  tsMs: number;
  variant: NonNullable<ChartAnnotationData["variant"]>;
  tone: "fg-subtle";
  side: NonNullable<ChartAnnotationData["align"]>;
  leftPx: number;
  fitPx: number;
  more: number;
}

const shown = (label: string, more: number) =>
  more > 0 ? `${label} +${more}` : label;

/**
 * The annotations inside the window ending at `tEndMs`, laid out through
 * `layoutMarkers` for a plot `widthPx` wide. Scale the width estimate for
 * larger captions. Markers outside the window are dropped.
 */
export function annotationsModel(
  annotations: readonly ChartAnnotationData[] | undefined,
  tEndMs: number,
  windowMs: number,
  widthPx: number,
  captionScale = 1
): PlacedAnnotation[] {
  if (!annotations?.length || widthPx <= 0 || windowMs <= 0) return [];
  const fromMs = tEndMs - windowMs;
  const span = Math.max(1, tEndMs - fromMs);
  const inWindow = annotations
    .filter((a) => annotationFraction(a.tsMs, tEndMs, windowMs) !== null)
    .map(({ tsMs, label, variant = "marker" }) => ({
      key: `${tsMs}-${label}`,
      tMs: tsMs,
      tsMs,
      label,
      variant,
      xFrac: (tsMs - fromMs) / span,
      tone: "fg-subtle" as const,
    }))
    .sort((p, q) => p.tMs - q.tMs);
  const layout = (merged: ReadonlyMap<string, number>) =>
    layoutMarkers(inWindow, {
      fromMs,
      toMs: tEndMs,
      widthPx,
      measure: (a) =>
        shown(a.label, merged.get(a.key) ?? 0).length *
          CHART_CAPTION_CHAR_WIDTH_PX *
          captionScale +
        16,
      side: (a) =>
        (annotationFraction(a.tsMs, tEndMs, windowMs) ?? 0) > 0.5
          ? "end"
          : "start",
      hangPx: 0,
    });
  // Reserve room for the "+N" suffix of merged labels.
  const first = layout(new Map());
  const merged = new Map(
    first.filter((p) => p.more > 0).map((p) => [p.key, p.more])
  );
  const placed = merged.size > 0 ? layout(merged) : first;
  for (const a of placed) a.label = shown(a.label, a.more);
  return placed;
}

/** Horizontal position inside a window ending at `tEndMs`, or null outside it. */
export function annotationFraction(
  tsMs: number,
  tEndMs: number,
  windowMs: number
): number | null {
  if (windowMs <= 0) return null;
  const f = 1 - (tEndMs - tsMs) / windowMs;
  return f < 0 || f > 1 ? null : f;
}
