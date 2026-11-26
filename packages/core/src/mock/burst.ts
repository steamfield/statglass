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
  type CoreRange,
  coreNoise,
  coreRange,
  coreWindowS,
  gatedShare,
  layerMean,
} from "./burst-expectation";
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
export const LANDS: ReadonlySet<Shape> = new Set([
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
/** Room for a wide span's episodes or breakpoints before it grows. */
const START_CAPACITY = 16;
/**
 * A layer or core with more windows than this in a span counts by its
 * long-run figures (`burst-expectation.ts`), not window by window.
 */
const MAX_WINDOWS = 4096;

/** No contribution: a core counted window by window adds nothing more. */
const ZERO_RANGE: CoreRange = { min: 0, avg: 0, max: 0 };

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
  /** Window `k`, `[from, to)`, and its episode `[start, end)`; empty when equal. */
  k: number;
  from: number;
  to: number;
  start: number;
  end: number;
  level: number;
  /** A wide span's episodes, in order. */
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
  return {
    layer,
    keys: [key(0), key(1), key(2), key(3)],
    k: Number.NaN,
    from: Number.POSITIVE_INFINITY,
    to: Number.NEGATIVE_INFINITY,
    start: 0,
    end: 0,
    level: 0,
    count: 0,
    starts: new Float64Array(START_CAPACITY),
    ends: new Float64Array(START_CAPACITY),
    levels: new Float64Array(START_CAPACITY),
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

/** Records `run`'s current episode after its others, growing room as needed. */
function pushEpisode(run: LayerRun): void {
  if (run.count === run.starts.length) {
    const grown = (from: Float64Array) => {
      const to = new Float64Array(from.length * 2);
      to.set(from);
      return to;
    };
    run.starts = grown(run.starts);
    run.ends = grown(run.ends);
    run.levels = grown(run.levels);
  }
  run.starts[run.count] = run.start;
  run.ends[run.count] = run.end;
  run.levels[run.count] = run.level;
  run.count++;
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
  /** What the core's noise adds to its noiseless value (`coreBase`). */
  private readonly noiseRange: CoreRange;
  /** The noiseless core's range and mean, for spans of thousands of windows. */
  private readonly range: CoreRange;
  private readonly coreWindowS: number;
  /** Each run's long-run average, with the share of time it may run. */
  private readonly means: number[];
  /** The core's current window (`steps` and `regime` cores). */
  private coreK = Number.NaN;
  private coreFrom = 0;
  private coreTo = 0;
  private coreRamp = 0;
  private coreDrift = 0;
  /** A wide span's running extremes, and the core's breakpoints in it, sorted. */
  private lo = 0;
  private hi = 0;
  private breaks = new Float64Array(START_CAPACITY);
  private breakCount = 0;
  /** Each run's next edge in a wide span's sweep (`edgeAt`), and its time. */
  private readonly edge: Int32Array;
  private readonly ahead: Float64Array;
  /** Whether the core moves between breakpoints (steps and lag), not only at them. */
  private readonly sloped: boolean;
  /** Whether the span counts the core by `range` rather than window by window. */
  private coreExpected = false;
  /** What layers counted by their means may add to a span's extremes. */
  private expectedLo = 0;
  private expectedHi = 0;
  /** Scratch for `reading`'s mean, so a tick allocates nothing for it. */
  private readonly span: SpanStats = { min: 0, avg: 0, max: 0 };
  /**
   * What the shape is eased by at `LAND_S` to sit exactly on 1, fading out
   * over `LAND_FADE_S` either side; 0 for shapes that do not land (`LANDS`).
   */
  readonly landing: number;

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
    this.noiseRange = coreNoise(this.core);
    this.edge = new Int32Array(this.runs.length);
    this.ahead = new Float64Array(this.runs.length);
    this.sloped = this.core?.kind === "steps" || this.core?.kind === "lag";
    this.range = coreRange(this.core);
    this.coreWindowS = coreWindowS(this.core);
    const gated = gatedShare(this.core);
    this.means = profile.layers.map(
      (l) => layerMean(l) * (l.gated ? gated : 1)
    );
    this.landing = LANDS.has(shape) ? 1 - this.shapeAt(LAND_S) : 0;
  }

  /** The multiplier at shape second `sec`. */
  at(sec: number): number {
    const away = Math.abs(sec - LAND_S);
    const v = this.shapeAt(sec);
    return away < LAND_FADE_S ? v + this.landing * (1 - away / LAND_FADE_S) : v;
  }

  /**
   * A reading taken at `sec` over `spanS` seconds: the mean of the seconds up
   * to and including it, or the instant when `spanS` is 0 (`meanSpanS`).
   */
  reading(sec: number, spanS: number): number {
    if (spanS === 0) return this.at(sec);
    return this.stats(sec - spanS + 1, sec + 1, this.span).avg;
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
   * Min, average and max over the whole seconds in `[a, b)`, into `out`. Up
   * to a minute it reads every one, as the ring's rows are. Wider, the
   * average is exact but for the core's noise, counted at its mean, and the
   * extremes are the noiseless values' at every breakpoint, widened by how
   * far the noise reaches, so they never sit inside any narrower bucket's.
   */
  stats(a: number, b: number, out: SpanStats): SpanStats {
    if (b - a <= EXACT_S) return this.exactSpan(a, b, out);
    const nearLanding =
      this.landing !== 0 &&
      a < LAND_S + LAND_FADE_S &&
      b > LAND_S - LAND_FADE_S;
    if (!nearLanding) return this.wideSpan(a, b, out);
    if (b - a <= LAND_EXACT_S) return this.exactSpan(a, b, out);
    // So wide a span barely moves: count the landing in its average, and
    // widen the extremes by it.
    this.wideSpan(a, b, out);
    out.avg += (this.landing * LAND_FADE_S) / (Math.ceil(b) - Math.ceil(a));
    out.min += Math.min(0, this.landing);
    out.max += Math.max(0, this.landing);
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

  /**
   * A wide span's stats. Between two breakpoints (a core step, ramp or lag
   * corner, an episode's start or end) the noiseless value is linear, so its
   * sum is a trapezoid's and its extremes sit at the seconds either side of
   * a breakpoint. Parts with thousands of windows in the span count by their
   * long-run mean and widen the extremes by their whole range.
   */
  private wideSpan(a: number, b: number, out: SpanStats): SpanStats {
    const first = Math.ceil(a);
    const end = Math.ceil(b);
    const width = end - first;
    this.coreExpected = width > MAX_WINDOWS * this.coreWindowS;
    this.breakCount = 0;
    let sum = this.coreExpected
      ? width * this.range.avg
      : this.coreSum(first, end);
    sum += this.layerSum(first, end);
    this.lo = Number.POSITIVE_INFINITY;
    this.hi = Number.NEGATIVE_INFINITY;
    this.sweep(first, end);
    const { noiseRange: noise, range } = this;
    const core = this.coreExpected ? range : ZERO_RANGE;
    out.avg = sum / width + noise.avg;
    out.min = this.lo + this.expectedLo + core.min + noise.min;
    out.max = this.hi + this.expectedHi + core.max + noise.max;
    return out;
  }

  /**
   * The weighted layers' sum over seconds `[first, end)`: recorded episode
   * by episode, or by their mean when they have too many windows in it.
   */
  private layerSum(first: number, end: number): number {
    let sum = 0;
    this.expectedLo = 0;
    this.expectedHi = 0;
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i] as LayerRun;
      const weight = this.weights[i] as number;
      const { layer } = run;
      if (end - first <= MAX_WINDOWS * layer.windowS) {
        sum += weight * this.record(run, first, end);
        continue;
      }
      run.count = 0;
      run.spanA = Number.NaN;
      sum += weight * (this.means[i] as number) * (end - first);
      this.expectedLo += weight * Math.min(0, layer.lo);
      this.expectedHi += weight * Math.max(0, layer.hi);
    }
    return sum;
  }

  /**
   * Records `run`'s episodes in seconds `[first, end)` and returns their
   * integral; a shared run another series just recorded over the same span
   * is kept as it is.
   */
  private record(run: LayerRun, first: number, end: number): number {
    if (run.spanA === first && run.spanB === end) return run.integral;
    const w = run.layer.windowS;
    let sum = 0;
    run.count = 0;
    for (let k = Math.floor(first / w); k * w < end; k++) {
      if (run.k !== k) this.draw(run, k);
      const s = Math.max(run.start, first);
      const e = Math.min(run.end, end);
      if (e <= s) continue;
      sum += (e - s) * run.level;
      pushEpisode(run);
    }
    run.spanA = first;
    run.spanB = end;
    run.integral = sum;
    return sum;
  }

  /**
   * Visits the noiseless value at every second it can peak or dip, in time
   * order with the recorded layers' running sum: the span's first and last
   * second, and each episode edge and core breakpoint. A sloped core can
   * also turn on the second before one; a flat one cannot.
   */
  private sweep(first: number, end: number): void {
    const { runs, weights, edge } = this;
    const sloped = this.sloped && !this.coreExpected;
    let layers = 0;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i] as LayerRun;
      const active = run.count > 0 && (run.starts[0] as number) <= first;
      edge[i] = active ? 1 : 0;
      this.ahead[i] = this.edgeAt(i);
      if (active) layers += (run.levels[0] as number) * (weights[i] as number);
    }
    let b = 0;
    this.visit(first, layers);
    for (;;) {
      const p = this.nextEdge(b);
      if (p >= end) break;
      if (sloped) this.visit(p - 1, layers);
      layers += this.crossEdges(p);
      while (b < this.breakCount && this.breaks[b] === p) b++;
      this.visit(p, layers);
    }
    this.visit(end - 1, layers);
  }

  /** The earliest edge ahead: an episode's start or end, or core breakpoint `b`. */
  private nextEdge(b: number): number {
    let p =
      b < this.breakCount
        ? (this.breaks[b] as number)
        : Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.runs.length; i++) {
      const e = this.ahead[i] as number;
      if (e < p) p = e;
    }
    return p;
  }

  /** Run `i`'s next edge: its current episode's start, then its end. */
  private edgeAt(i: number): number {
    const run = this.runs[i] as LayerRun;
    const j = this.edge[i] as number;
    if (j >= 2 * run.count) return Number.POSITIVE_INFINITY;
    return (j & 1 ? run.ends[j >> 1] : run.starts[j >> 1]) as number;
  }

  /** Steps every run past its edges at `p`; returns the layers' change. */
  private crossEdges(p: number): number {
    let change = 0;
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i] as LayerRun;
      while (this.ahead[i] === p) {
        const j = this.edge[i] as number;
        const level =
          (run.levels[j >> 1] as number) * (this.weights[i] as number);
        change += j & 1 ? -level : level;
        this.edge[i] = j + 1;
        this.ahead[i] = this.edgeAt(i);
      }
    }
    return change;
  }

  /** Counts the noiseless value at second `s` into the span's extremes. */
  private visit(s: number, layers: number): void {
    const core = this.coreExpected ? 0 : this.coreBase(s);
    const v = core + layers;
    if (v < this.lo) this.lo = v;
    if (v > this.hi) this.hi = v;
  }

  /** The noiseless core's sum over seconds `[first, end)`, by its segments. */
  private coreSum(first: number, end: number): number {
    this.collectBreaks(first, end);
    let sum = 0;
    let p = first;
    for (let j = 0; j < this.breakCount; j++) {
      const q = this.breaks[j] as number;
      sum += this.segmentSum(p, q);
      p = q;
    }
    return sum + this.segmentSum(p, end);
  }

  /** The sum over seconds `[p, q)` of a core linear across them. */
  private segmentSum(p: number, q: number): number {
    if (q <= p) return 0;
    return ((q - p) * (this.coreBase(p) + this.coreBase(q - 1))) / 2;
  }

  /**
   * The core's breakpoints inside `(first, end)`, sorted: regime and step
   * windows and ramp ends, and the lag's corners where a busy episode starts
   * or ends and `lagS` later.
   */
  private collectBreaks(first: number, end: number): void {
    this.breakCount = 0;
    const core = this.core;
    if (core === null || core.kind === "idle" || core.kind === "baseline")
      return;
    if (core.kind === "lag") {
      const w = BUSY.windowS;
      for (let k = Math.floor((first - core.lagS) / w); k * w < end; k++) {
        if (this.lag.k !== k) drawEpisode(this.lag, k, true);
        const { start, end: stop } = this.lag;
        if (stop === start) continue;
        this.addBreak(start, first, end);
        this.addBreak(stop, first, end);
        this.addBreak(start + core.lagS, first, end);
        this.addBreak(stop + core.lagS, first, end);
      }
      this.breaks.subarray(0, this.breakCount).sort();
      return;
    }
    const w = core.windowS;
    for (let k = Math.floor(first / w); k * w < end; k++) {
      this.addBreak(k * w, first, end);
      if (core.kind !== "steps") continue;
      this.steps(k);
      this.addBreak(Math.ceil(k * w + this.coreRamp), first, end);
    }
  }

  private addBreak(p: number, first: number, end: number): void {
    if (p <= first || p >= end) return;
    if (this.breakCount === this.breaks.length) {
      const grown = new Float64Array(this.breaks.length * 2);
      grown.set(this.breaks);
      this.breaks = grown;
    }
    this.breaks[this.breakCount++] = p;
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
    if (core.kind !== "baseline")
      return this.coreBase(sec) + core.jitter * this.noise(sec);
    // Two 16-bit uniforms from one draw: their sum is a triangle.
    const h = mix(this.noiseKey ^ Math.floor(sec * NOISE_HZ));
    const u = (h & 0xffff) / 65536 + (h >>> 16) / 65536;
    return core.median * Math.exp(core.spread * (u - 1));
  }

  /** The core at `sec` without its noise: what it moves around. */
  private coreBase(sec: number): number {
    const core = this.core;
    if (core === null) return 1;
    switch (core.kind) {
      case "idle":
        return core.center;
      case "baseline":
        return core.median;
      case "steps":
        return this.stepsAt(sec, core.windowS);
      case "regime":
        this.regime(Math.floor(sec / core.windowS));
        return this.coreFrom === 1 ? core.idle : this.coreTo;
      case "lag":
        return (
          core.center +
          (core.gain * this.lagIntegral(sec - core.lagS, sec)) / core.lagS
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

  /** A step core: ramp from the last window's offset to this one's, and drift. */
  private stepsAt(sec: number, windowS: number): number {
    const k = Math.floor(sec / windowS);
    if (this.coreK !== k) this.steps(k);
    const x = sec - k * windowS;
    const ramp = Math.min(1, x / this.coreRamp);
    return (
      1 +
      this.coreFrom +
      (this.coreTo - this.coreFrom) * ramp +
      (this.coreDrift * x) / windowS
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
