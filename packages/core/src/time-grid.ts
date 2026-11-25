/**
 * Snapping a time to a grid of `step` ms anchored at the epoch. Correct for
 * negative times too (`%` alone keeps the sign of `t`).
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The grid line at or before `t`. */
export const floorTo = (t: number, step: number): number =>
  t - (((t % step) + step) % step);

/** The grid line at or after `t`. */
export const ceilTo = (t: number, step: number): number => {
  const f = floorTo(t, step);
  return f === t ? t : f + step;
};
