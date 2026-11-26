/**
 * What a burst profile (`burst-profiles.ts`) does in the long run: each
 * layer's average level, and the range and average of each core without its
 * noise. `Shaper.stats` counts a span so wide that a layer or core has
 * thousands of windows in it by these instead of window by window, so a read
 * across years stays as quick as one across a month.
 */
import { BUSY, type Core, type Layer } from "./burst-profiles";

/** A noiseless core's lowest and highest value, and its long-run mean. */
export interface CoreRange {
  min: number;
  avg: number;
  max: number;
}

/** A layer's long-run average level: how often, how long and how high. */
export function layerMean(layer: Layer): number {
  const length = (layer.minS + layer.maxS) / 2;
  return (
    (((layer.chance * length) / layer.windowS) * (layer.lo + layer.hi)) / 2
  );
}

/** The share of the time gated layers run: the core's bursty regimes. */
export function gatedShare(core: Core | null): number {
  return core?.kind === "regime" ? core.burstyChance : 1;
}

/** The range and mean of `core` without its noise; 1 without a core. */
export function coreRange(core: Core | null): CoreRange {
  if (core === null) return { min: 1, avg: 1, max: 1 };
  switch (core.kind) {
    case "idle":
      return { min: core.center, avg: core.center, max: core.center };
    case "baseline":
      return { min: core.median, avg: core.median, max: core.median };
    case "steps": {
      // Offsets and drifts are drawn evenly either side of zero.
      const reach = core.amp + core.drift;
      return { min: 1 - reach, avg: 1, max: 1 + reach };
    }
    case "regime": {
      const plateau = (core.lo + core.hi) / 2;
      const idles = core.burstyChance > 0;
      return {
        min: idles ? Math.min(core.idle, core.lo) : core.lo,
        avg: core.burstyChance * core.idle + (1 - core.burstyChance) * plateau,
        max: idles ? Math.max(core.idle, core.hi) : core.hi,
      };
    }
    case "lag":
      return {
        min: core.center,
        avg: core.center + core.gain * layerMean(BUSY),
        max: core.center + core.gain * BUSY.hi,
      };
  }
}

/**
 * What `core`'s noise adds to its noiseless value: at least `min`, at most
 * `max`, `avg` on average. Jitter is even either side; a baseline's log-normal
 * looking spread, e^(spread (u - 1)) with u the sum of two uniforms, reaches
 * further up than down and lifts the mean.
 */
export function coreNoise(core: Core | null): CoreRange {
  if (core === null) return { min: 0, avg: 0, max: 0 };
  if (core.kind !== "baseline")
    return { min: -core.jitter, avg: 0, max: core.jitter };
  const { median: m, spread: s } = core;
  return {
    min: m * (Math.exp(-s) - 1),
    avg: m * ((Math.sinh(s / 2) / (s / 2)) ** 2 - 1),
    max: m * (Math.exp(s) - 1),
  };
}

/** The window the core's breakpoints come in, or Infinity when it has none. */
export function coreWindowS(core: Core | null): number {
  if (core === null || core.kind === "idle" || core.kind === "baseline")
    return Number.POSITIVE_INFINITY;
  return core.kind === "lag" ? BUSY.windowS : core.windowS;
}
