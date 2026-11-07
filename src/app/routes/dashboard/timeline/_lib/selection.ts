import type { TimeRange } from "@core/brush";
import { ceilTo, floorTo, MINUTE_MS } from "@core/time-grid";

/** Selection follows displayed bucket edges, never inventing finer precision. */
export function selectedRange(
  a: number,
  b: number,
  bucketMs: number,
  nowMs: number,
  retainedFrom = 0
): TimeRange | null {
  const minimum = Math.max(MINUTE_MS, bucketMs);
  let fromMs = floorTo(Math.min(a, b), bucketMs);
  let toMs = ceilTo(Math.max(a, b), bucketMs);
  if (toMs - fromMs < minimum) toMs = fromMs + minimum;
  toMs = Math.min(toMs, nowMs);
  fromMs = Math.max(retainedFrom, Math.min(fromMs, toMs - minimum));
  return toMs - fromMs >= minimum ? { fromMs, toMs } : null;
}
