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
        "inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-subtle",
        align === "end" && "flex-row-reverse",
        variant === "pill" &&
          "rounded-mark border border-border bg-card px-1.5 py-0.5"
      )}
    >
      {variant === "marker" && (
        <span aria-hidden className="h-5 w-px bg-border-strong" />
      )}
      {label}
    </span>
  );
}

/** Row pitch when annotations stack, px: the 20 px marker plus a gap. */
const ROW_PX = 22;

/** A label's width in px, estimated from its length like the Timeline's pills. */
const annotationWidth = (a: ChartAnnotationProps) => a.label.length * 6 + 16;

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
  const end = (a: ChartAnnotationProps) =>
    (annotationFraction(a.tsMs, tEndMs, windowMs) ?? 0) > 0.5;
  const placed = layoutMarkers(
    annotations
      .filter((a) => annotationFraction(a.tsMs, tEndMs, windowMs) !== null)
      .map((a) => ({ ...a, tMs: a.tsMs }))
      .sort((p, q) => p.tMs - q.tMs),
    {
      fromMs: tEndMs - windowMs,
      toMs: tEndMs,
      widthPx,
      measure: annotationWidth,
      side: (a) => (end(a) ? "end" : "start"),
      hangPx: 0,
    }
  );
  return placed.map(({ tMs: _, leftPx, row, more, ...a }) => {
    // An end-side label is anchored by its right edge, so the marker lands
    // on its time whatever the label's real width.
    const right = widthPx - leftPx - annotationWidth(a);
    return (
      <div
        key={`${a.tsMs}-${a.label}`}
        className="absolute"
        style={{
          top: 12 + row * ROW_PX,
          ...(end(a) ? { right } : { left: leftPx }),
        }}
      >
        <ChartAnnotation
          {...a}
          label={more > 0 ? `${a.label} +${more}` : a.label}
          align={end(a) ? "end" : "start"}
        />
      </div>
    );
  });
}

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
