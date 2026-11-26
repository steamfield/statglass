/**
 * The min, average and max of the mock's series over history buckets, on the
 * live generator's clock (`shapeSecond` from the ring's start). A bucket of a
 * minute or less reads every second the ring would hold a row for, so it
 * summarises exactly those rows; a wider one reads each shape's span
 * (`Shaper.stats`). Derived series (`derived-series.ts`) are combined from
 * their parts' buckets, so a total's bucket is the sum of its parts'.
 * Constant series drift a little, keyed by bucket so any range agrees.
 */
import type { HistoryPoint } from "@core/generated/types";
import { seriesKeyString } from "@core/series-key";
import { HOUR_MS } from "@core/time-grid";
import { Shaper, type SpanStats, scaled, shapeSecond, unit } from "./burst";
import { clampRound, derive, isDerived, shareOf } from "./derived-series";
import type { SeriesSpec } from "./generator";
import { seedOf } from "./rng";

/** Buckets up to this wide read every second. */
const EXACT_MS = 60_000;
/** The most whole seconds such a bucket covers. */
const EXACT_SECONDS = EXACT_MS / 1000;

/** The series a derived spec is computed from. */
const sourcesOf = (spec: SeriesSpec): readonly number[] =>
  spec.shareOf !== undefined
    ? [spec.shareOf]
    : (spec.sumOf ?? spec.restOf ?? []);

/**
 * The specs whose buckets `wanted` needs summarised, in index order: the
 * wanted ones and every spec they are derived from, less constants nothing
 * is derived from (their points drift on their own).
 */
function summarised(
  specs: readonly SeriesSpec[],
  wanted: readonly number[]
): number[] {
  const need = new Set<number>();
  const visit = (i: number, source: boolean) => {
    const spec = specs[i] as SeriesSpec;
    if (need.has(i) || (!source && isDrifting(spec))) return;
    need.add(i);
    for (const p of sourcesOf(spec)) visit(p, true);
  };
  for (const i of wanted) visit(i, false);
  return [...need].sort((a, b) => a - b);
}

/** A constant series not derived from others: its points drift (`driftingPoint`). */
const isDrifting = (spec: SeriesSpec) =>
  spec.shape === "constant" && !isDerived(spec);

/**
 * Bucket summaries for some of a layout's series at one bucket width. Call
 * `fill` with a bucket's start, then read each wanted series' `point`.
 *
 * Series on one shape and seed (CPU time, memory, a disk's transfers) share
 * one shaper, a "unit", read once per second. A series' bucket comes from its
 * unit's extremes and mean, as scaling is linear, and residency from its
 * source's, as a share is. Only totals, their parts and a series clamped
 * within the bucket are read second by second: a total's extremes are not
 * the sum of its parts'.
 */
export class HistoryBuckets {
  private readonly need: number[];
  /** Summarised series read second by second: totals and their parts. */
  private readonly perSecond: number[];
  private readonly isPerSecond: Uint8Array;
  private readonly units: Shaper[] = [];
  /** Each series' unit, or -1 when derived or not summarised. */
  private readonly unitOf: Int32Array;
  /**
   * Each unit's multiplier at each second of the bucket (unit-major, so a
   * unit's episode cache stays warm), and over the bucket.
   */
  private readonly unitAt: Float64Array;
  private readonly unitMin: Float64Array;
  private readonly unitAvg: Float64Array;
  private readonly unitMax: Float64Array;
  private readonly min: Float64Array;
  private readonly avg: Float64Array;
  private readonly max: Float64Array;
  /** Each series' reading at the second being read. */
  private readonly now: Float64Array;
  private readonly span: SpanStats = { min: 0, avg: 0, max: 0 };
  /** Each drifting series' seed. */
  private readonly driftSeeds: number[];

  constructor(
    private readonly specs: readonly SeriesSpec[],
    wanted: readonly number[],
    private readonly stepMs: number,
    private readonly anchorMs: number
  ) {
    this.need = summarised(specs, wanted);
    this.isPerSecond = new Uint8Array(specs.length);
    for (const i of this.need) {
      const parts = (specs[i] as SeriesSpec).sumOf ?? [];
      if (parts.length > 0) this.isPerSecond[i] = 1;
      for (const p of parts) this.isPerSecond[p] = 1;
    }
    this.perSecond = this.need.filter((i) => this.isPerSecond[i] === 1);
    this.unitOf = new Int32Array(specs.length).fill(-1);
    const units = new Map<string, number>();
    for (const i of this.need) {
      const spec = specs[i] as SeriesSpec;
      if (isDerived(spec)) continue;
      const id = `${spec.shape}:${spec.seed}`;
      const u =
        units.get(id) ?? this.units.push(new Shaper(spec.shape, spec.seed)) - 1;
      units.set(id, u);
      this.unitOf[i] = u;
    }
    const perUnit = () => new Float64Array(this.units.length);
    this.unitAt = new Float64Array(this.units.length * EXACT_SECONDS);
    this.unitMin = perUnit();
    this.unitAvg = perUnit();
    this.unitMax = perUnit();
    this.min = new Float64Array(specs.length);
    this.avg = new Float64Array(specs.length);
    this.max = new Float64Array(specs.length);
    this.now = new Float64Array(specs.length);
    this.driftSeeds = specs.map((s, i) =>
      wanted.includes(i) && isDrifting(s) ? seedOf(seriesKeyString(s.key)) : 0
    );
  }

  /** Summarises the bucket starting at wall-clock `t`. */
  fill(t: number): void {
    const a = shapeSecond(t, this.anchorMs);
    const b = a + this.stepMs / 1000;
    if (this.stepMs <= EXACT_MS) this.fillExact(a, b);
    else this.fillWide(a, b);
  }

  /** Series `i`'s point for the bucket at `t` last filled. */
  point(i: number, t: number): HistoryPoint {
    const spec = this.specs[i] as SeriesSpec;
    if (isDrifting(spec))
      return driftingPoint(spec, this.driftSeeds[i] ?? 0, t, this.stepMs);
    return {
      t,
      min: this.min[i] as number,
      avg: this.avg[i] as number,
      max: this.max[i] as number,
    };
  }

  /** Every whole second in `[a, b)`, as the ring's rows read them. */
  private fillExact(a: number, b: number): void {
    const { perSecond, min, avg, max } = this;
    const first = Math.ceil(a);
    const n = Math.ceil(b) - first;
    this.readUnits(first, n);
    for (const i of perSecond) {
      min[i] = Number.POSITIVE_INFINITY;
      max[i] = Number.NEGATIVE_INFINITY;
      avg[i] = 0;
    }
    for (let j = 0; j < n; j++) this.readSeries(j);
    for (const i of perSecond)
      avg[i] = Math.round(((avg[i] as number) / n) * 1000) / 1000;
    for (const i of this.need) {
      if (this.isPerSecond[i]) continue;
      if (this.unitOf[i] === -1) this.combine(i, this.specs[i] as SeriesSpec);
      else this.fromUnit(i, n);
    }
  }

  /** Each unit's multiplier at the `n` seconds from `first`, and their extremes and mean. */
  private readUnits(first: number, n: number): void {
    const { units, unitAt, unitMin, unitAvg, unitMax } = this;
    for (let u = 0; u < units.length; u++) {
      const shaper = units[u] as Shaper;
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const v = shaper.at(first + j);
        unitAt[u * EXACT_SECONDS + j] = v;
        sum += v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      unitMin[u] = lo;
      unitAvg[u] = sum / n;
      unitMax[u] = hi;
    }
  }

  /** The per-second series' readings at the bucket's `j`th second, counted in. */
  private readSeries(j: number): void {
    const { perSecond, specs, now, unitAt, unitOf, min, avg, max } = this;
    for (let k = 0; k < perSecond.length; k++) {
      const i = perSecond[k] as number;
      const spec = specs[i] as SeriesSpec;
      const u = unitOf[i] as number;
      const v =
        u < 0
          ? (derive(now, spec, specs) as number)
          : clampRound(
              scaled(
                unitAt[u * EXACT_SECONDS + j] as number,
                spec.base,
                spec.swing
              ),
              spec
            );
      now[i] = v;
      avg[i] = (avg[i] as number) + v;
      if (v < (min[i] as number)) min[i] = v;
      if (v > (max[i] as number)) max[i] = v;
    }
  }

  /**
   * Series `i`'s bucket of `n` seconds from its unit's. Clamping is not
   * linear, so when the bucket reaches past the series' range its mean is of
   * the clamped readings, second by second.
   */
  private fromUnit(i: number, n: number): void {
    const spec = this.specs[i] as SeriesSpec;
    const u = this.unitOf[i] as number;
    const x = scaled(this.unitMin[u] as number, spec.base, spec.swing);
    const y = scaled(this.unitMax[u] as number, spec.base, spec.swing);
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    let mean = scaled(this.unitAvg[u] as number, spec.base, spec.swing);
    if (lo < (spec.min ?? -Infinity) || hi > (spec.max ?? Infinity)) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const m = this.unitAt[u * EXACT_SECONDS + j] as number;
        sum += clampRound(scaled(m, spec.base, spec.swing), spec);
      }
      mean = sum / n;
    }
    this.set(i, lo, mean, hi);
  }

  /** Each unit's span stats; series from their unit's, derived ones from their parts'. */
  private fillWide(a: number, b: number): void {
    const { span } = this;
    for (let u = 0; u < this.units.length; u++) {
      (this.units[u] as Shaper).stats(a, b, span);
      this.unitMin[u] = span.min;
      this.unitAvg[u] = span.avg;
      this.unitMax[u] = span.max;
    }
    for (const i of this.need) {
      const spec = this.specs[i] as SeriesSpec;
      const u = this.unitOf[i] as number;
      if (u < 0) {
        this.combine(i, spec);
        continue;
      }
      const lo = scaled(this.unitMin[u] as number, spec.base, spec.swing);
      const hi = scaled(this.unitMax[u] as number, spec.base, spec.swing);
      const avg = scaled(this.unitAvg[u] as number, spec.base, spec.swing);
      this.set(i, Math.min(lo, hi), avg, Math.max(lo, hi));
    }
  }

  /** A derived series' bucket from its parts' buckets. */
  private combine(i: number, spec: SeriesSpec): void {
    if (spec.shareOf !== undefined) {
      const k = shareOf(spec, this.specs);
      const j = spec.shareOf;
      this.set(
        i,
        (this.min[j] as number) * k,
        (this.avg[j] as number) * k,
        (this.max[j] as number) * k
      );
      return;
    }
    let min = 0;
    let avg = 0;
    let max = 0;
    for (const p of sourcesOf(spec)) {
      min += this.min[p] as number;
      avg += this.avg[p] as number;
      max += this.max[p] as number;
    }
    if (spec.restOf) this.set(i, 100 - max, 100 - avg, 100 - min);
    else this.set(i, min, avg, max);
  }

  private set(i: number, min: number, avg: number, max: number): void {
    const spec = this.specs[i] as SeriesSpec;
    this.min[i] = clampRound(min, spec);
    this.avg[i] = clampRound(avg, spec);
    this.max[i] = clampRound(max, spec);
  }
}

const SALT_WAVE = 11;
const SALT_LOW = 12;
const SALT_HIGH = 13;

/**
 * A constant series' bucket: a slow sine within 5% of its value, with noise
 * keyed by the bucket. A wider bucket's min and max sit further from its
 * average: x1 at 10 s, about x1.8 at 1 min, x3 from 30 min, so the envelope
 * on 7d and 30d reads as one.
 */
function driftingPoint(
  s: SeriesSpec,
  seed: number,
  t: number,
  step: number
): HistoryPoint {
  const k = Math.floor(t / step);
  const amp = Math.abs(s.base) * 0.05;
  const spread = Math.min(3, 1 + Math.log10(step / 10_000));
  const wave =
    Math.sin(t / (3 * HOUR_MS)) * 0.6 + (unit(seed, SALT_WAVE, k) - 0.5) * 0.8;
  const avg = clampRound(s.base + wave * amp, s);
  return {
    t,
    avg,
    min: clampRound(avg - amp * 0.4 * spread * unit(seed, SALT_LOW, k), s),
    max: clampRound(avg + amp * 0.6 * spread * unit(seed, SALT_HIGH, k), s),
  };
}
