/**
 * Seeded burst model for the mock's series: the value of a series kind
 * (`Shape`, profiled in `burst-profiles.ts`) at any second, and the min,
 * average and max over any span of seconds, as a pure function of the seed
 * and the time. Live ticks and history buckets read the same model, so a
 * wider bucket's max catches the spikes its average hides, as the store's
 * rollups do.
 *
 * Values are multipliers of the series' sample value; `scaled` turns one into
 * a reading. A `Shaper` caches the episode of each layer's current window, so
 * a live tick costs a few hashes and allocates nothing: the phone's demo
 * backfills several hosts under Hermes, which has no JIT.
 */
import {
  BUSY,
  type Layer,
  PROFILES,
  type Profile,
  type Shape,
} from "./burst-profiles";

export type { Shape } from "./burst-profiles";

/** The host's seed for `shared` layers, so load series move together. */
const SHARED_SEED = 5;

const SALT_JITTER = 1;
const SALT_JITTER_B = 2;
const SALT_CORE = 3;
const SALT_WEIGHT = 7;

/** At most this many core samples per span: the core is noise around a level. */
const SPAN_SAMPLES = 8;

/** murmur3's 32-bit finalizer. */
function mix(x: number): number {
  let h = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A uniform draw in [0, 1) for `k` on `seed`'s `salt` stream. */
export function unit(seed: number, salt: number, k: number): number {
  return mix(mix(seed ^ Math.imul(salt, 0x9e3779b9)) ^ k) / 4294967296;
}

/** Min, average and max over a span, as multipliers of the sample value. */
export interface SpanStats {
  min: number;
  avg: number;
  max: number;
}

/** A reading from a multiplier: `swing` per unit away from `base`. */
export function scaled(m: number, base: number, swing = base): number {
  return base + swing * (m - 1);
}

/** One window's episode, `[start, end)` in seconds; empty when start = end. */
interface Episode {
  k: number;
  start: number;
  end: number;
  level: number;
}

const newEpisode = (): Episode => ({
  k: Number.NaN,
  start: 0,
  end: 0,
  level: 0,
});

/** Draws window `k`'s episode of `layer` into `ep`; none unless `allowed`. */
function drawEpisode(
  layer: Layer,
  seed: number,
  k: number,
  allowed: boolean,
  ep: Episode
): void {
  ep.k = k;
  ep.start = k * layer.windowS;
  ep.end = ep.start;
  ep.level = 0;
  if (!allowed || unit(seed, layer.salt, k) >= layer.chance) return;
  const span = layer.maxS - layer.minS + 1;
  const length = layer.minS + Math.floor(unit(seed, layer.salt + 1, k) * span);
  ep.start += Math.floor(
    unit(seed, layer.salt + 2, k) * (layer.windowS - length + 1)
  );
  ep.end = ep.start + length;
  ep.level = layer.lo + unit(seed, layer.salt + 3, k) * (layer.hi - layer.lo);
}

/** ±1 uniform noise for second `sec`. */
const jitterAt = (seed: number, sec: number) =>
  2 * unit(seed, SALT_JITTER, sec) - 1;

/**
 * One series' view of its profile. Stateless in meaning (any second can be
 * asked in any order), stateful only as a cache of the current windows.
 */
export class Shaper {
  private readonly profile: Profile;
  private readonly layerSeeds: number[];
  /** Shared layers lift this series by its own share; its own layers by 1. */
  private readonly weights: number[];
  private readonly episodes: Episode[];
  private readonly lagEpisode = newEpisode();
  /** The core's current window (`steps` and `regime` cores). */
  private coreK = Number.NaN;
  private coreFrom = 0;
  private coreTo = 0;
  private coreRamp = 0;
  private coreDrift = 0;
  /** `layerSpan`'s answer: the integral, and the lowest and highest level. */
  private spanSum = 0;
  private spanLo = 0;
  private spanHi = 0;

  constructor(
    shape: Shape,
    private readonly seed: number
  ) {
    this.profile = PROFILES[shape];
    const share = 0.5 + 0.8 * unit(seed, SALT_WEIGHT, 0);
    this.layerSeeds = this.profile.layers.map((l) =>
      l.shared ? SHARED_SEED : seed
    );
    this.weights = this.profile.layers.map((l) => (l.shared ? share : 1));
    this.episodes = this.profile.layers.map(newEpisode);
  }

  /** The multiplier at second `sec`. */
  at(sec: number): number {
    let v = this.coreAt(sec);
    const layers = this.profile.layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i] as Layer;
      const ep = this.episodes[i] as Episode;
      const k = Math.floor(sec / layer.windowS);
      if (ep.k !== k) this.draw(layer, i, k);
      if (sec >= ep.start && sec < ep.end)
        v += ep.level * (this.weights[i] ?? 1);
    }
    return v;
  }

  /** Min, average and max over seconds `[fromSec, toSec)`, into `out`. */
  stats(fromSec: number, toSec: number, out: SpanStats): SpanStats {
    const a = Math.floor(fromSec);
    const width = Math.max(1, Math.floor(toSec) - a);
    this.coreSpan(a, width, out);
    const layers = this.profile.layers;
    for (let i = 0; i < layers.length; i++) {
      const w = this.weights[i] ?? 1;
      this.layerSpan(layers[i] as Layer, i, a, a + width);
      out.avg += (w * this.spanSum) / width;
      out.min += w * this.spanLo;
      out.max += w * this.spanHi;
    }
    return out;
  }

  /** The core's min, average and max from evenly spaced samples. */
  private coreSpan(a: number, width: number, out: SpanStats): void {
    const n = Math.min(width, SPAN_SAMPLES);
    let sum = 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      const v = this.coreAt(a + Math.floor(((j + 0.5) * width) / n));
      sum += v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out.min = lo;
    out.avg = sum / n;
    out.max = hi;
  }

  /** Integral and level bounds of layer `i` over `[a, b)`, into `span*`. */
  private layerSpan(layer: Layer, i: number, a: number, b: number): void {
    const ep = i < 0 ? this.lagEpisode : (this.episodes[i] as Episode);
    let sum = 0;
    let lo = 0;
    let hi = 0;
    for (let k = Math.floor(a / layer.windowS); k * layer.windowS < b; k++) {
      if (ep.k !== k) this.draw(layer, i, k);
      const s = Math.max(ep.start, a);
      const e = Math.min(ep.end, b);
      if (e <= s) continue;
      sum += (e - s) * ep.level;
      // Covering the whole span, the episode is all the span sees.
      if (s === a && e === b) lo = hi = ep.level;
      else if (ep.level > hi) hi = ep.level;
      else if (ep.level < lo) lo = ep.level;
    }
    this.spanSum = sum;
    this.spanLo = lo;
    this.spanHi = hi;
  }

  /** Refreshes layer `i`'s cached episode (-1: the thermal lag's busy layer). */
  private draw(layer: Layer, i: number, k: number): void {
    const allowed = !layer.gated || this.burstyAt(k * layer.windowS);
    if (i < 0) drawEpisode(layer, SHARED_SEED, k, allowed, this.lagEpisode);
    else
      drawEpisode(
        layer,
        this.layerSeeds[i] ?? this.seed,
        k,
        allowed,
        this.episodes[i] as Episode
      );
  }

  private coreAt(sec: number): number {
    const core = this.profile.core;
    if (core === null) return 1;
    switch (core.kind) {
      case "idle":
        return core.center + core.jitter * jitterAt(this.seed, sec);
      case "baseline": {
        const u =
          unit(this.seed, SALT_JITTER, sec) +
          unit(this.seed, SALT_JITTER_B, sec);
        return core.median * Math.exp(core.spread * (u - 1));
      }
      case "steps":
        return this.stepsAt(sec, core.windowS, core.jitter);
      case "regime":
        this.regime(Math.floor(sec / core.windowS));
        return (
          (this.coreFrom === 1 ? core.idle : this.coreTo) +
          core.jitter * jitterAt(this.seed, sec)
        );
      case "lag":
        this.layerSpan(BUSY, -1, sec - core.lagS, sec);
        return (
          core.center +
          (core.gain * this.spanSum) / core.lagS +
          core.jitter * jitterAt(this.seed, sec)
        );
    }
  }

  /** A step core: ramp from the last window's offset to this one's, drift, noise. */
  private stepsAt(sec: number, windowS: number, jitter: number): number {
    const k = Math.floor(sec / windowS);
    if (this.coreK !== k) this.steps(k);
    const x = sec - k * windowS;
    const ramp = Math.min(1, x / this.coreRamp);
    return (
      1 +
      this.coreFrom +
      (this.coreTo - this.coreFrom) * ramp +
      (this.coreDrift * x) / windowS +
      jitter * jitterAt(this.seed, sec)
    );
  }

  /** Caches step window `k`: the offsets it ramps between, its ramp and drift. */
  private steps(k: number): void {
    const core = this.profile.core;
    if (core?.kind !== "steps") return;
    this.coreK = k;
    this.coreFrom = core.amp * (2 * unit(this.seed, SALT_CORE, k - 1) - 1);
    this.coreTo = core.amp * (2 * unit(this.seed, SALT_CORE, k) - 1);
    this.coreRamp =
      core.rampMinS +
      unit(this.seed, SALT_CORE + 1, k) * (core.rampMaxS - core.rampMinS);
    this.coreDrift = core.drift * (2 * unit(this.seed, SALT_CORE + 2, k) - 1);
  }

  /** Caches regime `k`: `coreFrom` 1 when bursty, `coreTo` its plateau. */
  private regime(k: number): void {
    const core = this.profile.core;
    if (this.coreK === k || core?.kind !== "regime") return;
    this.coreK = k;
    this.coreFrom = unit(this.seed, SALT_CORE, k) < core.burstyChance ? 1 : 0;
    this.coreTo =
      core.lo + unit(this.seed, SALT_CORE + 1, k) * (core.hi - core.lo);
  }

  private burstyAt(sec: number): boolean {
    const core = this.profile.core;
    if (core?.kind !== "regime") return true;
    this.regime(Math.floor(sec / core.windowS));
    return this.coreFrom === 1;
  }
}

const longRun = new Map<string, number>();
const DAY_S = 86_400;
const CHUNK_S = 600;

/**
 * The average multiplier of `shape` on `seed` over a week, for fixtures that
 * know a range's average and need buckets around it.
 */
export function longRunMean(shape: Shape, seed: number): number {
  const key = `${shape}:${seed}`;
  const known = longRun.get(key);
  if (known !== undefined) return known;
  const shaper = new Shaper(shape, seed);
  const out: SpanStats = { min: 0, avg: 0, max: 0 };
  let sum = 0;
  for (let a = 0; a < 7 * DAY_S; a += CHUNK_S)
    sum += shaper.stats(a, a + CHUNK_S, out).avg;
  const mean = sum / ((7 * DAY_S) / CHUNK_S);
  longRun.set(key, mean);
  return mean;
}
