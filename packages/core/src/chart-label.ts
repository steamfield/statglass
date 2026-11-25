import { spanWords } from "./live-window";
import { floorTo } from "./time-grid";

export function chartLabel(input: {
  subject: string;
  spanMs: number;
  now: string | null;
  brushable?: boolean;
}): string {
  return chartLabelForSpan({ ...input, span: spanWords(input.spanMs, null) });
}

/** Also accepts a named span, such as "selected dates" on the desktop. */
export function chartLabelForSpan({
  subject,
  span,
  now,
  brushable,
}: {
  subject: string;
  span: string;
  now: string | null;
  brushable?: boolean;
}): string {
  const label = `${subject}, ${span}${now ? `, ${now}` : ""}.`;
  return brushable ? `${label} Drag to select a range.` : label;
}

/** A dash while readings are pending should never hold a bucket. */
export function hasChartReading(now: string | null | undefined): boolean {
  return /[0-9]/.test(now ?? "");
}

/** Hold figures until the host stream moves to a different bucket. */
export function shouldRefreshFigures(
  prev: { bucketMs: number; edgeMs: number } | null,
  next: { bucketMs: number; edgeMs: number }
): boolean {
  return (
    prev === null ||
    prev.bucketMs !== next.bucketMs ||
    floorTo(prev.edgeMs, prev.bucketMs) !== floorTo(next.edgeMs, next.bucketMs)
  );
}
