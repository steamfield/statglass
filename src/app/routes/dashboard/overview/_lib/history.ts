/** The scale for an Overview bar: the 24 h maximum, never below `floor`. */
export function scaleFrom(max: number | null | undefined, floor: number) {
  return Math.max(floor, max ?? 0);
}
