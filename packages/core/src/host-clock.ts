/** Minimum clock correction that refreshes displayed history; matches the Rust emit gate. */
export const CLOCK_STEP_THRESHOLD_MS = 1000;

/** Source wall time anchored to monotonic elapsed time, immune to controller clock steps. */
export function hostClock(
  offsetMs: number,
  wallMs = Date.now(),
  monotonicMs = performance.now()
) {
  return () => wallMs + offsetMs + performance.now() - monotonicMs;
}
