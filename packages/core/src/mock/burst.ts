/**
 * Seeded burst model for the mock's series: the value of a series kind
 * (`Shape`, profiled in `burst-profiles.ts`) at any instant, and the min,
 * average and max over any span, as a pure function of the seed and the time.
 * Live ticks and history buckets read the same model on the same clock
 * (`shapeSecond`), so a bucket summarises exactly the rows the ring holds.
 *
 * Values are multipliers of the series' sample value; `scaled` turns one into
 * a reading. A `Shaper` caches the episode of each layer's current window, so
 * a live tick costs a few hashes and allocates nothing: the phone's demo
 * backfills several hosts under Hermes, which has no JIT.
 */
import {
  BUSY,
  type Core,
  type Layer,
  PROFILES,
  type Shape,
} from "./burst-profiles";

export type { Shape } from "./burst-profiles";

/**
 * The shape second the mock's start (a backfill's last row) sits on: an idle
 * moment, so a fresh window opens on calm figures rather than mid-burst.
 * Found by search: every layout's load, memory, GPU and thermal series within
 * about 20% of their sample values, the GPU on a plateau, and no network or
 * disk burst and no CPU spike in the 30 s before it.
 */
export const LAND_S = 113_887;

/**
 * Seconds either side of `LAND_S` over which a calm shape eases onto its
 * sample value, so a fresh window opens on the boards' figures (D-053)
 * without a jump: the shape is a few percent off it there, noise and all.
 */
const LAND_FADE_S = 30;

/**
 * Shapes that land on the sample value. Bursty ones (network, disk) land on
 * whatever they are doing, an idle baseline, since easing a 40x burst in
 * would be a spike.
 */
const LANDS: ReadonlySet<Shape> = new Set([
  "load",
  "level",
  "gpu",
  "plateau",
  "thermal",
]);

/** A wide span this short around the landing is read second by second. */
const LAND_EXACT_S = 4 * 3600;

/** The shape second of wall-clock `ms`, with `anchorMs` on `LAND_S`. */
export function shapeSecond(ms: number, anchorMs: number): number {
  return (ms - anchorMs) / 1000 + LAND_S;
}

/** The host's seed for `shared` layers, so load series move together. */
const SHARED_SEED = 5;
const SALT_JITTER = 1;
const SALT_CORE = 3;
const SALT_WEIGHT = 7;
/** Noise is drawn per tenth of a second, so sub-second intervals vary. */
const NOISE_HZ = 10;
/** Spans up to this many seconds are read second by second, exactly. */
const EXACT_S = 60;
/** Core samples per wider span, besides every breakpoint. */
const CORE_SAMPLES = 8;
/** A layer whose window fits this often in a span counts by expectation. */
const FINE_RATIO = 32;
/** Episodes one coarse layer can have in a span: its windows, plus two. */
const MAX_EPISODES = FINE_RATIO + 2;

/** murmur3's 32-bit finalizer. */
function mix(x: number): number {
  let h = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The hashed key of `seed`'s `salt` stream; `draw` reads it. */
const streamKey = (seed: number, salt: number) =>
  mix(seed ^ Math.imul(salt, 0x9e3779b9));

/** A uniform draw in [0, 1) for `k` on a stream. */
const draw = (key: number, k: number) => mix(key ^ k) / 4294967296;

/** A uniform draw in [0, 1) for `k` on `seed`'s `salt` stream. */
export function unit(seed: number, salt: number, k: number): number {
  return draw(streamKey(seed, salt), k);
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

/**
 * One layer on one seed: its streams, cache and span scratch. Shared layers
 * have one run for every series (`sharedRun`), so a host's load series draw
 * and record their common episodes once.
 */
interface LayerRun {
  layer: Layer;
  /** Streams for whether, how long, where and how high window k's episode is. */
  keys: [number, number, number, number];
  /** The layer's long-run average level. */
  mean: number;
  /** Window `k`, `[from, to)`, and its episode `[start, end)`; empty when equal. */
  k: number;
  from: number;
  to: number;
  start: number;
  end: number;
  level: number;
  /** A wide span's episodes, or -1 when the layer counts by expectation. */
  count: number;
  starts: Float64Array;
  ends: Float64Array;
  levels: Float64Array;
  /** The span last recorded, `[spanA, spanB)`, and its integral. */
  spanA: number;
  spanB: number;
  integral: number;
}

function layerRun(layer: Layer, seed: number): LayerRun {
  const key = (j: number) => streamKey(seed, layer.salt + j);
  const length = (layer.minS + layer.maxS) / 2;
  return {
    layer,
    keys: [key(0), key(1), key(2), key(3)],
    mean:
      (((layer.chance * length) / layer.windowS) * (layer.lo + layer.hi)) / 2,
    k: Number.NaN,
    from: Number.POSITIVE_INFINITY,
    to: Number.NEGATIVE_INFINITY,
    start: 0,
    end: 0,
    level: 0,
    count: 0,
    starts: new Float64Array(MAX_EPISODES),
    ends: new Float64Array(MAX_EPISODES),
    levels: new Float64Array(MAX_EPISODES),
    spanA: Number.NaN,
    spanB: Number.NaN,
    integral: 0,
  };
}

const sharedRuns = new Map<Layer, LayerRun>();

/** The one run of a shared layer, on the host's shared seed. */
function sharedRun(layer: Layer): LayerRun {
  let run = sharedRuns.get(layer);
  if (!run) {
    run = layerRun(layer, SHARED_SEED);
    sharedRuns.set(layer, run);
  }
  return run;
}

/** Draws window `k`'s episode into `run`; none unless `allowed`. */
function drawEpisode(run: LayerRun, k: number, allowed: boolean): void {
  const { layer, keys } = run;
  run.k = k;
  run.from = k * layer.windowS;
  run.to = run.from + layer.windowS;
  run.start = run.from;
  run.end = run.start;
  run.level = 0;
  if (!allowed || draw(keys[0], k) >= layer.chance) return;
  const span = layer.maxS - layer.minS + 1;
  const length = layer.minS + Math.floor(draw(keys[1], k) * span);
  run.start += Math.floor(draw(keys[2], k) * (layer.windowS - length + 1));
  run.end = run.start + length;
  run.level = layer.lo + draw(keys[3], k) * (layer.hi - layer.lo);
}

/**
 * The last recorded episode of `run` starting at or before `s`, or -1. A
 * layer's episodes are recorded in window order and never overlap, so their
 * starts are sorted.
 */
function lastStartedBy(run: LayerRun, s: number): number {
  let lo = 0;
  let hi = run.count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((run.starts[mid] as number) <= s) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * One series' view of its profile. Stateless in meaning (any instant can be
 * asked in any order), stateful only as a cache of the current windows.
 */
export class Shaper {
  private readonly core: Core | null;
  private readonly runs: LayerRun[];
  /** How strongly this series feels each run: shared layers vary by series. */
  private readonly weights: number[];
  /** The thermal lag's view of the shared busy layer. */
  private readonly lag: LayerRun;
  private readonly noiseKey: number;
  private readonly coreKeys: [number, number, number];
  /** The core's current window (`steps` and `regime` cores). */
  private coreK = Number.NaN;
  private coreFrom = 0;
  private coreTo = 0;
  private coreRamp = 0;
  private coreDrift = 0;
  /** A wide span's running extremes. */
  private lo = 0;
  private hi = 0;
  /** What the shape adds at `LAND_S` to sit exactly on 1 (`LAND_FADE_S`). */
  private readonly landing: number;

  constructor(shape: Shape, seed: number) {
    const profile = PROFILES[shape];
    this.core = profile.core;
    const share = 0.5 + 0.8 * unit(seed, SALT_WEIGHT, 0);
    this.runs = profile.layers.map((l) =>
      l.shared ? sharedRun(l) : layerRun(l, seed)
    );
    this.weights = profile.layers.map((l) => (l.shared ? share : 1));
    this.lag = sharedRun(BUSY);
    this.noiseKey = streamKey(seed, SALT_JITTER);
    this.coreKeys = [
      streamKey(seed, SALT_CORE),
      streamKey(seed, SALT_CORE + 1),
      streamKey(seed, SALT_CORE + 2),
    ];
    this.landing = LANDS.has(shape) ? 1 - this.shapeAt(LAND_S) : 0;
  }

  /** The multiplier at shape second `sec`. */
  at(sec: number): number {
    const away = Math.abs(sec - LAND_S);
    const v = this.shapeAt(sec);
    return away < LAND_FADE_S ? v + this.landing * (1 - away / LAND_FADE_S) : v;
  }

  /** The profile's multiplier at `sec`, before landing. */
  private shapeAt(sec: number): number {
    let v = this.coreAt(sec);
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i] as LayerRun;
      v += this.levelAt(run, sec) * (this.weights[i] as number);
    }
    return v;
  }

  /**
   * Min, average and max over `[a, b)`, into `out`. Up to a minute it reads
   * every whole second, as the ring's rows are; wider, the average is exact
   * for coarse layers and expected for fine ones, and the extremes are the
   * values at every breakpoint plus the fine layers' expected highest.
   */
  stats(a: number, b: number, out: SpanStats): SpanStats {
    if (b - a <= EXACT_S) return this.exactSpan(a, b, out);
    const nearLanding =
      this.landing !== 0 &&
      a < LAND_S + LAND_FADE_S &&
      b > LAND_S - LAND_FADE_S;
    if (!nearLanding) return this.wideSpan(a, b, out);
    if (b - a <= LAND_EXACT_S) return this.exactSpan(a, b, out);
    // So wide a span barely moves: count the landing in its average only.
    this.wideSpan(a, b, out);
    out.avg += (this.landing * LAND_FADE_S) / (b - a);
    out.min = Math.min(out.min, out.avg);
    out.max = Math.max(out.max, out.avg);
    return out;
  }

  private exactSpan(a: number, b: number, out: SpanStats): SpanStats {
    let s = Math.ceil(a);
    if (s >= b) s = a;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let n = 0;
    for (; n === 0 || s < b; s++, n++) {
      const v = this.at(s);
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out.min = min;
    out.avg = sum / n;
    out.max = max;
    return out;
  }

  private wideSpan(a: number, b: number, out: SpanStats): SpanStats {
    const first = Math.ceil(a);
    const width = b - a;
    let avg = 0;
    let fineMin = 0;
    let fineMax = 0;
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i] as LayerRun;
      const weight = this.weights[i] as number;
      const { layer } = run;
      if (layer.windowS * FINE_RATIO >= width) {
        avg += (weight * this.record(run, a, b)) / width;
        continue;
      }
      run.count = -1;
      run.spanA = Number.NaN;
      const share = layer.gated ? this.burstyShare(a, b) : 1;
      avg += weight * run.mean * share;
      const n = (layer.chance * share * width) / layer.windowS;
      if (n >= 0.5)
        fineMax += weight * (layer.lo + ((layer.hi - layer.lo) * n) / (n + 1));
      if (share > 0) fineMin += weight * Math.min(0, layer.lo);
    }
    this.lo = Number.POSITIVE_INFINITY;
    this.hi = Number.NEGATIVE_INFINITY;
    let coreSum = 0;
    for (let j = 0; j < CORE_SAMPLES; j++) {
      const s = first + Math.floor(((j + 0.5) * (b - first)) / CORE_SAMPLES);
      coreSum += this.visit(s, b);
    }
    this.visit(first, b);
    this.visitEpisodes(first, b);
    this.visitCore(first, b);
    out.avg = coreSum / CORE_SAMPLES + avg;
    // The average is estimated apart from the extremes: keep it between them.
    out.min = Math.min(this.lo + fineMin, out.avg);
    out.max = Math.max(this.hi + fineMax, out.avg);
    return out;
  }

  /**
   * Records `run`'s episodes in `[a, b)` and returns their integral; a shared
   * run another series just recorded over the same span is kept as it is.
   */
  private record(run: LayerRun, a: number, b: number): number {
    if (run.spanA === a && run.spanB === b) return run.integral;
    const w = run.layer.windowS;
    let sum = 0;
    run.count = 0;
    for (let k = Math.floor(a / w); k * w < b; k++) {
      if (run.k !== k) this.draw(run, k);
      const s = Math.max(run.start, a);
      const e = Math.min(run.end, b);
      if (e <= s) continue;
      sum += (e - s) * run.level;
      if (run.count >= MAX_EPISODES) continue;
      run.starts[run.count] = run.start;
      run.ends[run.count] = run.end;
      run.levels[run.count] = run.level;
      run.count++;
    }
    run.spanA = a;
    run.spanB = b;
    run.integral = sum;
    return sum;
  }

  /** The recorded coarse layers' sum at `s`. */
  private recordedAt(s: number): number {
    let v = 0;
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i] as LayerRun;
      const e = lastStartedBy(run, s);
      if (e >= 0 && s < (run.ends[e] as number))
        v += (run.levels[e] as number) * (this.weights[i] as number);
    }
    return v;
  }

  /** Counts the value at `s` into the span's extremes; returns the core's part. */
  private visit(s: number, b: number): number {
    const core = this.coreAt(s);
    if (s >= b) return core;
    const v = core + this.recordedAt(s);
    if (v < this.lo) this.lo = v;
    if (v > this.hi) this.hi = v;
    return core;
  }

  /** Visits every recorded episode's first second and the second after it. */
  private visitEpisodes(first: number, b: number): void {
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i] as LayerRun;
      for (let e = 0; e < run.count; e++) {
        this.visit(Math.max(first, run.starts[e] as number), b);
        this.visit(run.ends[e] as number, b);
      }
    }
  }

  /** Visits the core's breakpoints: steps, ramps, regimes and lag corners. */
  private visitCore(first: number, b: number): void {
    const core = this.core;
    if (core === null || core.kind === "idle" || core.kind === "baseline")
      return;
    if (core.kind === "lag") {
      this.visitLag(first, b, core.lagS);
      return;
    }
    const w = core.windowS;
    for (let k = Math.floor(first / w); k * w < b; k++) {
      this.visit(Math.max(first, k * w), b);
      if (core.kind !== "steps") continue;
      this.steps(k);
      this.visitFrom(first, Math.ceil(k * w + this.coreRamp), b);
    }
  }

  /** The lag core bends where a busy episode starts or ends, and `lagS` later. */
  private visitLag(first: number, b: number, lagS: number): void {
    const w = BUSY.windowS;
    for (let k = Math.floor((first - lagS) / w); k * w < b; k++) {
      if (this.lag.k !== k) drawEpisode(this.lag, k, true);
      if (this.lag.end === this.lag.start) continue;
      const { start, end } = this.lag;
      this.visitFrom(first, start, b);
      this.visitFrom(first, end, b);
      this.visitFrom(first, start + lagS, b);
      this.visitFrom(first, end + lagS, b);
    }
  }

  private visitFrom(first: number, s: number, b: number): void {
    if (s >= first) this.visit(s, b);
  }

  /** The share of `[a, b)` in bursty regimes. */
  private burstyShare(a: number, b: number): number {
    const core = this.core;
    if (core?.kind !== "regime") return 1;
    const w = core.windowS;
    let bursty = 0;
    for (let k = Math.floor(a / w); k * w < b; k++) {
      this.regime(k);
      if (this.coreFrom === 1)
        bursty += Math.min(b, (k + 1) * w) - Math.max(a, k * w);
    }
    return bursty / (b - a);
  }

  private levelAt(run: LayerRun, sec: number): number {
    if (sec < run.from || sec >= run.to)
      this.draw(run, Math.floor(sec / run.layer.windowS));
    return sec >= run.start && sec < run.end ? run.level : 0;
  }

  private draw(run: LayerRun, k: number): void {
    drawEpisode(
      run,
      k,
      !run.layer.gated || this.burstyAt(k * run.layer.windowS)
    );
  }

  /** ±1 uniform noise at `sec`. */
  private noise(sec: number): number {
    return 2 * draw(this.noiseKey, Math.floor(sec * NOISE_HZ)) - 1;
  }

  private coreAt(sec: number): number {
    const core = this.core;
    if (core === null) return 1;
    switch (core.kind) {
      case "idle":
        return core.center + core.jitter * this.noise(sec);
      case "baseline": {
        // Two 16-bit uniforms from one draw: their sum is a triangle.
        const h = mix(this.noiseKey ^ Math.floor(sec * NOISE_HZ));
        const u = (h & 0xffff) / 65536 + (h >>> 16) / 65536;
        return core.median * Math.exp(core.spread * (u - 1));
      }
      case "steps":
        return this.stepsAt(sec, core.windowS, core.jitter);
      case "regime":
        this.regime(Math.floor(sec / core.windowS));
        return (
          (this.coreFrom === 1 ? core.idle : this.coreTo) +
          core.jitter * this.noise(sec)
        );
      case "lag":
        return (
          core.center +
          (core.gain * this.lagIntegral(sec - core.lagS, sec)) / core.lagS +
          core.jitter * this.noise(sec)
        );
    }
  }

  /** The shared busy layer's integral over `[a, b)`. */
  private lagIntegral(a: number, b: number): number {
    const w = BUSY.windowS;
    let sum = 0;
    for (let k = Math.floor(a / w); k * w < b; k++) {
      if (this.lag.k !== k) drawEpisode(this.lag, k, true);
      const e = Math.min(this.lag.end, b) - Math.max(this.lag.start, a);
      if (e > 0) sum += e * this.lag.level;
    }
    return sum;
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
      jitter * this.noise(sec)
    );
  }

  /** Caches step window `k`: the offsets it ramps between, its ramp and drift. */
  private steps(k: number): void {
    const core = this.core;
    if (this.coreK === k || core?.kind !== "steps") return;
    const [offsets, ramps, drifts] = this.coreKeys;
    this.coreK = k;
    this.coreFrom = core.amp * (2 * draw(offsets, k - 1) - 1);
    this.coreTo = core.amp * (2 * draw(offsets, k) - 1);
    this.coreRamp =
      core.rampMinS + draw(ramps, k) * (core.rampMaxS - core.rampMinS);
    this.coreDrift = core.drift * (2 * draw(drifts, k) - 1);
  }

  /** Caches regime `k`: `coreFrom` 1 when bursty, `coreTo` its plateau. */
  private regime(k: number): void {
    const core = this.core;
    if (this.coreK === k || core?.kind !== "regime") return;
    this.coreK = k;
    this.coreFrom = draw(this.coreKeys[0], k) < core.burstyChance ? 1 : 0;
    this.coreTo = core.lo + draw(this.coreKeys[1], k) * (core.hi - core.lo);
  }

  private burstyAt(sec: number): boolean {
    const core = this.core;
    if (core?.kind !== "regime") return true;
    this.regime(Math.floor(sec / core.windowS));
    return this.coreFrom === 1;
  }
}
