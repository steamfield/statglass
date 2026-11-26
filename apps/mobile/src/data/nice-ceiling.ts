/** Ceiling hysteresis for the phone's live and history charts. */
import { type CeilingState, nextCeiling } from "@core/chart-math";
import { useMemo, useRef } from "react";

const MIN_TICK_GAP_MS = 10_000;

/**
 * Raise a chart ceiling at once and step it down after a sustained drop.
 * A new scope fits its values immediately.
 */
export function useNiceCeiling(
  values: readonly (number | null)[],
  nowMs: number,
  intervalMs: number,
  minCeiling: number,
  scope?: string
): number {
  const held = useRef<{
    scope: string | undefined;
    peak: number | null;
    state: CeilingState;
  } | null>(null);
  const peak = useMemo(() => {
    let max: number | null = null;
    for (const value of values) {
      if (value !== null && (max === null || value > max)) max = value;
    }
    return max;
  }, [values]);
  const previous = held.current?.scope === scope ? held.current : null;
  // A refreshed reply can change the peak at the same timestamp.
  if (previous?.state.lastMs === nowMs && previous.peak === peak) {
    return previous.state.ceiling;
  }
  const state = nextCeiling(previous?.state ?? null, peak, nowMs, {
    minCeiling,
    maxTickGapMs: Math.max(MIN_TICK_GAP_MS, 2 * intervalMs),
  });
  held.current = { scope, peak, state };
  return state.ceiling;
}
