import {
  annotationsModel,
  type ChartAnnotationData,
  type PlacedAnnotation,
} from "@core/widget-models/chart-annotation";
import { cn } from "~/lib/utils";

export { annotationFraction } from "@core/widget-models/chart-annotation";

/** A labelled marker inside a chart; the shared annotation data. */
export type ChartAnnotationProps = ChartAnnotationData;

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
  return (
    <PlacedChartAnnotations
      annotations={annotationsModel(annotations, tEndMs, windowMs, widthPx)}
      widthPx={widthPx}
    />
  );
}

/** Draws annotations already placed by a chart model. */
export function PlacedChartAnnotations({
  annotations,
  widthPx,
}: {
  annotations: readonly PlacedAnnotation[];
  widthPx: number;
}) {
  return annotations.map(
    ({ key, leftPx, row, side, fitPx, tsMs, label, variant }) => (
      <div
        key={key}
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
        <ChartAnnotation
          tsMs={tsMs}
          label={label}
          variant={variant}
          align={side}
        />
      </div>
    )
  );
}
