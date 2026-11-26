/**
 * Simulated readings for the site's live widgets, shaped like a real Mac's
 * history: long flat stretches with a little jitter, broken by spikes,
 * busy stretches and valleys, rather than a smooth wander. Every sampler is
 * seeded (Park–Miller), so every visitor, and the server render, sees the
 * same trace.
 *
 * The shapes come from an hour of a MacBook Pro's own StatGlass history:
 * CPU idling near 15% with spikes to 50–100% for seconds, network at a few
 * KB/s with 20–60 s download bursts and short upload blips, memory moving
 * in steps of a few GB, and the GPU switching between a flat plateau and
 * bursts from idle.
 */

export function seededRandom(seed: number) {
  let state = seed % 2147483647 || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

type Random = () => number;
const between = (r: Random, lo: number, hi: number) => lo + r() * (hi - lo);

/** An episode in progress: a level held for a number of seconds. */
interface Episode {
  left: number;
  level: number;
}

/** Starts an episode with chance `p` per second. */
function maybeStart(
  r: Random,
  p: number,
  seconds: readonly [number, number],
  level: () => number
): Episode | null {
  if (r() >= p) return null;
  return { left: Math.round(between(r, ...seconds)), level: level() };
}

/**
 * CPU load in percent: idle near 15% with ±2 jitter; spikes of 2–6 s to
 * 45–95%; busy stretches of 20–60 s around 25–40%; quiet valleys near 9%.
 */
export function createCpuSampler(seed = 7) {
  const r = seededRandom(seed);
  let episode: Episode | null = null;
  let level = 15;
  return function next(): number {
    if (episode && episode.left <= 0) episode = null;
    episode ??=
      maybeStart(r, 0.035, [2, 6], () => between(r, 45, 95)) ??
      maybeStart(r, 0.007, [20, 60], () => between(r, 25, 40)) ??
      maybeStart(r, 0.005, [10, 25], () => between(r, 7, 11));
    const target = episode ? episode.level : 15;
    if (episode) episode.left -= 1;
    // Spikes arrive within a second; everything else settles over a few.
    level += (target - level) * (target > level + 20 ? 0.85 : 0.45);
    const jitter = (r() - 0.5) * (episode ? 7 : 4);
    return round1(clamp(level + jitter, 3, 95));
  };
}

/**
 * GPU percent: a flat plateau for minutes (20–30% ±1), then a stretch of
 * near-idle with spikes to 40–80% for a few seconds.
 */
export function createGpuSampler(seed = 13) {
  const r = seededRandom(seed);
  let steady = true;
  let regimeLeft = Math.round(between(r, 60, 180));
  let plateau = between(r, 20, 30);
  let spike: Episode | null = null;
  return function next(): number {
    if (regimeLeft-- <= 0) {
      steady = !steady;
      regimeLeft = Math.round(
        steady ? between(r, 60, 180) : between(r, 30, 90)
      );
      plateau = between(r, 20, 30);
    }
    if (steady) return round1(clamp(plateau + (r() - 0.5) * 2, 1, 100));
    if (spike && spike.left <= 0) spike = null;
    spike ??= maybeStart(r, 0.08, [1, 4], () => between(r, 40, 80));
    if (!spike) return round1(between(r, 1, 5));
    spike.left -= 1;
    return round1(clamp(spike.level + (r() - 0.5) * 8, 1, 100));
  };
}

/**
 * A level such as memory in use, in the unit of `base`: flat with a little
 * drift, then a step of 4–12% of `base` up or down (an app opening or
 * quitting) that settles over a few seconds.
 */
export function createLevelSampler(
  seed: number,
  base: number,
  limits: readonly [number, number]
) {
  const r = seededRandom(seed);
  let target = base;
  let level = base;
  return function next(): number {
    if (r() < 0.012) {
      const step = base * between(r, 0.04, 0.12);
      // Lean back toward the base so it never walks off.
      const up = r() < (target > base ? 0.3 : 0.7);
      target = clamp(target + (up ? step : -step), ...limits);
    }
    target += (r() - 0.5) * base * 0.002;
    level += (target - level) * 0.25;
    return Math.round(clamp(level, ...limits) * 100) / 100;
  };
}

export interface RateShape {
  /** Typical idle rate; idle samples scatter log-normally around it. */
  idle: number;
  /** Rate during a burst. */
  peak: number;
  /** Chance per second a burst starts. */
  chance: number;
  /** Burst length range, seconds. */
  seconds: readonly [number, number];
}

/**
 * A transfer rate: a jittery trickle around `idle`, then a burst near
 * `peak` that ramps in over two seconds and drops straight back.
 */
export function createRateSampler(seed: number, shape: RateShape) {
  const r = seededRandom(seed);
  let burst: (Episode & { age: number }) | null = null;
  return function next(): number {
    if (burst && burst.left <= 0) burst = null;
    if (!burst) {
      const started = maybeStart(
        r,
        shape.chance,
        shape.seconds,
        () => between(r, 0.45, 1) * shape.peak
      );
      burst = started && { ...started, age: 0 };
    }
    // Mostly near `idle`, now and then several times it.
    const trickle = shape.idle * Math.exp((r() + r() + r() - 1.5) * 1.4);
    if (!burst) return trickle;
    burst.left -= 1;
    burst.age += 1;
    const ramp = Math.min(1, burst.age / 2);
    return trickle + burst.level * ramp * between(r, 0.75, 1.1);
  };
}

/** The first `length` samples of a sampler, oldest first. */
export function sampleHistory(next: () => number, length: number): number[] {
  return Array.from({ length }, () => next());
}

/** A seeded trace in each module's native unit: percent, GiB or MB/s. */
export type ModuleKey = "cpu" | "gpu" | "memory" | "network";

export const createMemorySampler = () => createLevelSampler(19, 18, [8, 30]);

/** Download, MB/s: a trickle, with a 15–40 s burst every minute or two. */
export const createNetworkSampler = () => {
  const next = createRateSampler(23, {
    idle: 0.02,
    peak: 38,
    chance: 0.012,
    seconds: [15, 40],
  });
  return () => round1(clamp(next(), 0.1, 50));
};

export const moduleSamplers = {
  cpu: createCpuSampler,
  gpu: createGpuSampler,
  memory: createMemorySampler,
  network: createNetworkSampler,
};
