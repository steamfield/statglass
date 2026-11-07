import { useRef } from "react";
import { useOpenEdge } from "~/hooks/use-range-scope";

export interface ChartLabel {
  /** What the chart shows: "CPU", "GPU power", "Network: upload above the line, download below". */
  subject: string;
  /** The span wording: "last 60 seconds", "last 15 minutes". */
  span: string;
  /** The figures now, as a clause: "now 34%", "used 12 GB, cached 3 GB". */
  now?: string | undefined;
  /** The chart takes a drag to select a range. */
  brushable?: boolean;
}

/**
 * A chart's accessible name, one wording everywhere (design-system.md
 * "Accessibility"): "CPU, last 60 seconds, now 17%." with " Drag to select
 * a range." on a brushable chart. The figures are held per 10 s bucket of
 * the live stream (`useOpenEdge`), so the name changes at most every 10 s
 * and a screen reader isn't flooded at 1 Hz; a new subject or span applies
 * at once, with the figures read fresh. A label without figures doesn't subscribe to the stream.
 */
export function useChartLabel({
  subject,
  span,
  now,
  brushable = false,
}: ChartLabel): string {
  const edge = useOpenEdge(now !== undefined);
  // The figures are read again on a new bucket, or when the chart itself
  // changes (another subject or span re-reads them at once). A render-time
  // latch: the same inputs always give the same text, where state would
  // cost a second render on every new bucket.
  const key = `${edge}|${subject}|${span}`;
  const held = useRef({ key, now });
  if (edge === null || held.current.key !== key) held.current = { key, now };
  const figures = held.current.now;
  const label = `${subject}, ${span}${figures ? `, ${figures}` : ""}.`;
  return brushable ? `${label} Drag to select a range.` : label;
}
