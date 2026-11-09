import { layoutMarkers } from "@core/chart-math";
import { cn } from "~/lib/utils";

export interface ChartAnnotationProps {
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

/**
 * Labelled marker inside a chart. Render-only: the chart wraps it
 * in a box positioned at `tsMs` on its own x scale.
 */
export function ChartAnnotation({
  tsMs,
  label,
  variant = "marker",
  align = "start",
}: ChartAnnotationProps) {
  return (
    <span
      data-annotation-ts={tsMs}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap text-fg-subtle text-label",
        align === "end" && "flex-row-reverse",
        variant === "pill" &&
          "rounded-mark border border-border bg-card px-1.5 py-0.5"
      )}
    >
      {variant === "marker" && (
        <span aria-hidden className="h-5 w-px shrink-0 bg-border-strong" />
      )}
      {/* Truncates only when the layout narrowed the box to fit the plot. */}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

/** Row pitch when annotations stack, px: the 20 px marker plus a gap. */
const ROW_PX = 22;

/** A label's width in px, estimated from its length like the Timeline's pills. */
const labelWidth = (label: string) => label.length * 6 + 16;

/**
 * The annotations inside a window ending at `tEndMs`, placed by the shared
 * marker layout (`layoutMarkers`): a label hangs right of its marker in the
 * plot's left half and left of it past the middle; a colliding one moves to
 * the second row, then merges into the nearest as "+N". `widthPx` is the
 * plot's measured width; nothing is placed until it is known.
 */
export function ChartAnnotations({
  annotations,
  tEndMs,
  windowMs,
  widthPx,
}: {
  annotations: readonly ChartAnnotationProps[] | undefined;
  tEndMs: number;
  windowMs: number;
  widthPx: number;
}) {
  if (!annotations || widthPx <= 0) return null;
  const inWindow = annotations
    .filter((a) => annotationFraction(a.tsMs, tEndMs, windowMs) !== null)
    .map((a) => ({ ...a, tMs: a.tsMs }))
    .sort((p, q) => p.tMs - q.tMs);
  const layout = (merged: ReadonlyMap<string, number>) =>
    layoutMarkers(inWindow, {
      fromMs: tEndMs - windowMs,
      toMs: tEndMs,
      widthPx,
      measure: (a) => labelWidth(shown(a.label, merged.get(keyOf(a)) ?? 0)),
      side: (a) =>
        (annotationFraction(a.tsMs, tEndMs, windowMs) ?? 0) > 0.5
          ? "end"
          : "start",
      hangPx: 0,
    });
  // A merged label grows by its "+N": lay out again with that width reserved.
  const first = layout(new Map());
  const merged = new Map(
    first.filter((p) => p.more > 0).map((p) => [keyOf(p), p.more])
  );
  const placed = merged.size > 0 ? layout(merged) : first;
  return placed.map(({ tMs: _, leftPx, row, more, side, fitPx, ...a }) => (
    <div
      key={keyOf(a)}
      className="absolute"
      style={{
        top: 12 + row * ROW_PX,
        maxWidth: fitPx,
        // An end-side label is anchored by its right edge, so the marker
        // lands on its time whatever the label's real width.
        ...(side === "end"
          ? { right: widthPx - leftPx - fitPx }
          : { left: leftPx }),
      }}
    >
      <ChartAnnotation {...a} label={shown(a.label, more)} align={side} />
    </div>
  ));
}

const keyOf = (a: ChartAnnotationProps) => `${a.tsMs}-${a.label}`;
const shown = (label: string, more: number) =>
  more > 0 ? `${label} +${more}` : label;

/**
 * Horizontal position of `tsMs` as a fraction of a window ending at `tEndMs`,
 * or null when it falls outside.
 */
export function annotationFraction(
  tsMs: number,
  tEndMs: number,
  windowMs: number
): number | null {
  if (windowMs <= 0) return null;
  const f = 1 - (tEndMs - tsMs) / windowMs;
  return f < 0 || f > 1 ? null : f;
}
