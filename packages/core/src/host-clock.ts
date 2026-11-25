/** Minimum clock correction that refreshes displayed history; matches the Rust emit gate. */
export const CLOCK_STEP_THRESHOLD_MS = 1000;

/** Project a fixed wall-clock timestamp onto the source clock. */
export const hostTime = (wallMs: number, offsetMs: number): number =>
  wallMs + offsetMs;

/** Source wall time anchored to monotonic elapsed time, immune to controller clock steps. */
export function hostClock(
  offsetMs: number,
  wallMs = Date.now(),
  monotonicMs = performance.now()
) {
  const anchorMs = hostTime(wallMs, offsetMs);
  return () => anchorMs + performance.now() - monotonicMs;
}
