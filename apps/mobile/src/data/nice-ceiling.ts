/** Ceiling hysteresis for the phone's live and history charts. */
import { type CeilingState, nextCeiling } from "@core/chart-math";
import { useMemo, useRef } from "react";

const MIN_TICK_GAP_MS = 10_000;

/** How often the chart's values advance, and what a held ceiling belongs to. */
export interface CeilingOptions {
  /** Twice this without a tick breaks the hold. */
  intervalMs: number;
  /** A new scope fits its values immediately. */
  scope?: string;
}

/**
 * Raise a chart ceiling at once and step it down after a sustained drop.
 * The first three arguments match the desktop hook's.
 */
export function useNiceCeiling(
  values: readonly (number | null)[],
  nowMs: number,
  minCeiling: number,
  { intervalMs, scope }: CeilingOptions
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
