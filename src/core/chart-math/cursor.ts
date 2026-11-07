/**
 * Cursor lookups: which slot or which plotted time sits under a pointer or a
 * hovered moment. Charts with evenly spaced bars use `indexAt`; charts whose
 * plotted times are sparse or uneven use `lastAtOrBefore` and `nearestTime`.
 */

/**
 * The slot `[0, count)` at `fraction` (0..1) across a plot of `count` equal
 * slots, or null off the plot. The right edge belongs to no slot.
 */
export function indexAt(fraction: number, count: number): number | null {
  if (!Number.isFinite(fraction) || count <= 0) return null;
  if (fraction < 0 || fraction >= 1) return null;
  return Math.min(count - 1, Math.floor(fraction * count));
}

/**
 * Index of the last item starting at or before `t` in items sorted by start,
 * or -1 when every item starts after it. Binary search.
 */
export function lastAtOrBefore<T>(
  items: readonly T[],
  t: number,
  start: (item: T) => number
): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (start(items[mid] as T) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

const self = (t: number) => t;

/**
 * The plotted time closest to `t` in ascending `times`, or null when there
 * are none; a tie goes to the later time.
 */
export function nearestTime(
  times: readonly number[],
  t: number
): number | null {
  const i = lastAtOrBefore(times, t, self);
  const before = times[i];
  const after = times[i + 1];
  if (before === undefined) return after ?? null;
  if (after === undefined) return before;
  return t - before < after - t ? before : after;
}
