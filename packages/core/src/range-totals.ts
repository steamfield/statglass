import { formatSpan } from "@core/format";

/**
 * A metric's measured time when it fell short of the range (asleep, the
 * module off), for "in 11 min" after its figure; null when it covered the
 * range. A second or 1% of slack absorbs sampling jitter.
 */
export function measuredShort(
  { measured_ms }: { measured_ms: number },
  spanMs: number
): string | null {
  if (spanMs <= 0 || measured_ms >= spanMs - Math.max(1_000, spanMs * 0.01)) {
    return null;
  }
  return formatSpan(measured_ms);
}
