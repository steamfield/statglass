import {
  type CeilingLadder,
  type CeilingState,
  nextCeiling,
} from "@core/chart-math";
import { useRef } from "react";

/** Below this, updates count as continuous whatever the interval (nextCeiling's default). */
const MIN_TICK_GAP_MS = 10_000;

/**
 * Autoscaled chart ceiling with the 60 s shrink hysteresis
 * (design-system.md "Chart rules"). Feed it the values in the chart's window
 * and the time of the newest one; it grows at once and shrinks only after a
 * minute below the next step down.
 *
 * Pass the chart's window as `windowMs`, and with `endMs` its fixed end (null
 * while it follows now): changing either drops the held ceiling and fits the
 * new range at once. The hysteresis only damps jitter while one range
 * streams. `intervalMs` is how far apart updates arrive; a history-backed
 * window refreshes once per bucket, which can be well over 10 s, and those
 * updates still count as continuous time below the next step.
 */
export function useNiceCeiling(
  values: readonly (number | null)[],
  nowMs: number,
  minCeiling = 1,
  windowMs?: number,
  {
    endMs = null,
    intervalMs = 0,
    ladder = "decimal",
  }: {
    endMs?: number | null;
    intervalMs?: number;
    /** The steps it snaps to (`niceCeiling`); a change refits at once. */
    ladder?: CeilingLadder;
  } = {}
): number {
  const state = useRef<CeilingState | null>(null);
  const lastMs = useRef<number | null>(null);
  const lastMax = useRef<number | null>(null);
  const scope = `${windowMs}:${endMs}:${ladder}`;
  const lastScope = useRef(scope);
  if (lastScope.current !== scope) {
    state.current = null;
    lastMs.current = null;
    lastScope.current = scope;
  }
  let max: number | null = null;
  for (const v of values) if (v !== null && (max === null || v > max)) max = v;
  // Selection changes can publish a larger series at the same history timestamp.
  if (lastMs.current !== nowMs || lastMax.current !== max) {
    state.current = nextCeiling(state.current, max, nowMs, {
      minCeiling,
      maxTickGapMs: Math.max(MIN_TICK_GAP_MS, 2 * intervalMs),
      ladder,
    });
    lastMs.current = nowMs;
    lastMax.current = max;
  }
  return state.current?.ceiling ?? minCeiling;
}
