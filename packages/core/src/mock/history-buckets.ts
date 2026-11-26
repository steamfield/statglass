/**
 * The min, average and max of the mock's series over history buckets, on the
 * live generator's clock (`shapeSecond` from the ring's start). A bucket of a
 * minute or less reads every row the ring would hold in it, at the sampling
 * interval and with each series' cadence and span, so it summarises exactly
 * those rows; a wider one reads each shape's span (`Shaper.stats`). Derived series (`derived-series.ts`) are combined from
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
import { meanSpanS, sampleCadence, samplesRow } from "./series-shapes";

/** Buckets up to this wide read every row. */
const EXACT_MS = 60_000;

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
 * Series on one shape and seed (CPU time, memory, a disk's transfers) that
 * read the same span share one shaper, a "unit", read once per row. A
 * series' bucket comes from its unit's extremes and mean, as scaling is
 * linear, and residency from its source's, as a share is. Totals, their
 * parts, series sampled on some rows only and a series clamped within the
 * bucket are read row by row: a total's extremes are not the sum of its
 * parts'.
 */
export class HistoryBuckets {
  private readonly need: number[];
  /** Summarised series read row by row: totals and their parts. */
  private readonly perRow: number[];
  private readonly isPerRow: Uint8Array;
  /** Ticks between each series' samples, and what its reading subtracts per tick. */
  private readonly cadence: Int32Array;
  private readonly pace: Float64Array;
  private readonly units: Shaper[] = [];
  /** Seconds each unit's readings average over (`meanSpanS`). */
  private readonly unitSpan: number[] = [];
  /** Each series' unit, or -1 when derived or not summarised. */
  private readonly unitOf: Int32Array;
  /** The most rows an exact bucket holds. */
  private readonly maxRows: number;
  /**
   * Each unit's multiplier at each row of the bucket (unit-major, so a
   * unit's episode cache stays warm), and over the bucket.
   */
  private readonly unitAt: Float64Array;
  private readonly unitMin: Float64Array;
  private readonly unitAvg: Float64Array;
  private readonly unitMax: Float64Array;
  private readonly min: Float64Array;
  private readonly avg: Float64Array;
  private readonly max: Float64Array;
  /** Each per-row series' reading at the row being read, and rows counted. */
  private readonly now: Float64Array;
  private readonly counted: Int32Array;
  /** The ring row the bucket being filled starts at (`samplesRow`). */
  private firstRow = 0;
  private rowCount = 0;
  private readonly span: SpanStats = { min: 0, avg: 0, max: 0 };
  /** Each drifting series' seed. */
  private readonly driftSeeds: number[];

  constructor(
    private readonly specs: readonly SeriesSpec[],
    wanted: readonly number[],
    private readonly stepMs: number,
    private readonly anchorMs: number,
    private readonly intervalMs: number
  ) {
    this.need = summarised(specs, wanted);
    this.isPerRow = new Uint8Array(specs.length);
    for (const i of this.need) {
      const parts = (specs[i] as SeriesSpec).sumOf ?? [];
      if (parts.length > 0) this.isPerRow[i] = 1;
      for (const p of parts) this.isPerRow[p] = 1;
    }
    this.perRow = this.need.filter((i) => this.isPerRow[i] === 1);
    this.cadence = Int32Array.from(specs, (s) =>
      sampleCadence(s, intervalMs, false)
    );
    this.pace = Float64Array.from(specs, (s) =>
      s.perTick === undefined ? 0 : s.perTick * (1 - 1000 / intervalMs)
    );
    this.unitOf = new Int32Array(specs.length).fill(-1);
    this.addUnits();
    this.maxRows = Math.floor(EXACT_MS / intervalMs) + 1;
    const perUnit = () => new Float64Array(this.units.length);
    this.unitAt = new Float64Array(this.units.length * this.maxRows);
    this.unitMin = perUnit();
    this.unitAvg = perUnit();
    this.unitMax = perUnit();
    this.min = new Float64Array(specs.length);
    this.avg = new Float64Array(specs.length);
    this.max = new Float64Array(specs.length);
    this.now = new Float64Array(specs.length);
    this.counted = new Int32Array(specs.length);
    this.driftSeeds = specs.map((s, i) =>
      wanted.includes(i) && isDrifting(s) ? seedOf(seriesKeyString(s.key)) : 0
    );
  }

  /** Summarises the bucket starting at wall-clock `t`. */
  fill(t: number): void {
    if (this.stepMs <= EXACT_MS) {
      this.fillExact(t);
      return;
    }
    const a = shapeSecond(t, this.anchorMs);
    this.fillWide(a, a + this.stepMs / 1000);
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

  /** One unit per shape, seed and span among the summarised series. */
  private addUnits(): void {
    const units = new Map<string, number>();
    for (const i of this.need) {
      const spec = this.specs[i] as SeriesSpec;
      if (isDerived(spec)) continue;
      const periodMs = (this.cadence[i] as number) * this.intervalMs;
      const span = meanSpanS(spec.key.metric, periodMs);
      const id = `${spec.shape}:${spec.seed}:${span}`;
      let u = units.get(id);
      if (u === undefined) {
        u = this.units.push(new Shaper(spec.shape, spec.seed)) - 1;
        this.unitSpan.push(span);
        units.set(id, u);
      }
      this.unitOf[i] = u;
    }
  }

  /**
   * The ring's rows in `[t, t + step)`, `anchorMs` plus whole intervals, as
   * the live generator takes them; the next row when none falls inside.
   */
  private fillExact(t: number): void {
    const { perRow, min, avg, max, counted, intervalMs } = this;
    const first = Math.ceil((t - this.anchorMs) / intervalMs);
    const end = Math.ceil((t + this.stepMs - this.anchorMs) / intervalMs);
    const n = Math.min(this.maxRows, Math.max(1, end - first));
    this.firstRow = first;
    this.rowCount = n;
    this.readUnits(first, n);
    for (const i of perRow) {
      min[i] = Number.POSITIVE_INFINITY;
      max[i] = Number.NEGATIVE_INFINITY;
      avg[i] = 0;
      counted[i] = 0;
    }
    for (let j = 0; j < n; j++) this.readRow(j);
    for (const i of perRow)
      avg[i] =
        Math.round(((avg[i] as number) / (counted[i] as number)) * 1000) / 1000;
    for (const i of this.need) {
      if (this.isPerRow[i]) continue;
      if (this.unitOf[i] === -1) this.combine(i, this.specs[i] as SeriesSpec);
      else this.fromUnit(i, n);
    }
  }

  /** Each unit's multiplier at the `n` rows from row `first`, and their extremes and mean. */
  private readUnits(first: number, n: number): void {
    const { units, unitAt, unitMin, unitAvg, unitMax, maxRows } = this;
    for (let u = 0; u < units.length; u++) {
      const shaper = units[u] as Shaper;
      const span = this.unitSpan[u] as number;
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const at = this.anchorMs + (first + j) * this.intervalMs;
        const v = shaper.reading(shapeSecond(at, this.anchorMs), span);
        unitAt[u * maxRows + j] = v;
        sum += v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      unitMin[u] = lo;
      unitAvg[u] = sum / n;
      unitMax[u] = hi;
    }
  }

  /** Whether series `i` is sampled on the bucket's `j`th row. */
  private sampled(i: number, j: number): boolean {
    return samplesRow(this.firstRow + j, this.cadence[i] as number);
  }

  /** Series `i`'s reading from its unit's multiplier `m`. */
  private readingOf(i: number, m: number): number {
    const spec = this.specs[i] as SeriesSpec;
    return clampRound(
      scaled(m, spec.base, spec.swing) - (this.pace[i] as number),
      spec
    );
  }

  /** The per-row series' readings at the bucket's `j`th row, counted in where sampled. */
  private readRow(j: number): void {
    const { perRow, specs, now, unitAt, unitOf, min, avg, max } = this;
    for (let k = 0; k < perRow.length; k++) {
      const i = perRow[k] as number;
      const u = unitOf[i] as number;
      const v =
        u < 0
          ? (derive(now, specs[i] as SeriesSpec, specs) as number)
          : this.readingOf(i, unitAt[u * this.maxRows + j] as number);
      now[i] = v;
      if (!this.sampled(i, j) && this.anySampled(i)) continue;
      this.counted[i] = (this.counted[i] as number) + 1;
      avg[i] = (avg[i] as number) + v;
      if (v < (min[i] as number)) min[i] = v;
      if (v > (max[i] as number)) max[i] = v;
    }
  }

  /** Whether any row of the bucket samples series `i`; when none does, all count. */
  private anySampled(i: number): boolean {
    const c = this.cadence[i] as number;
    if (c === 1) return true;
    const firstSampled = Math.ceil(this.firstRow / c) * c;
    return firstSampled - this.firstRow < this.rowCount;
  }

  /**
   * Series `i`'s bucket of `n` rows from its unit's. A series sampled on
   * every row and inside its range takes its unit's extremes and mean, as
   * scaling is linear; otherwise its sampled rows are read one by one.
   */
  private fromUnit(i: number, n: number): void {
    const spec = this.specs[i] as SeriesSpec;
    const u = this.unitOf[i] as number;
    const x = this.readingOf(i, this.unitMin[u] as number);
    const y = this.readingOf(i, this.unitMax[u] as number);
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    const inRange = lo > (spec.min ?? -Infinity) && hi < (spec.max ?? Infinity);
    if (this.cadence[i] === 1 && inRange) {
      this.set(i, lo, this.readingOf(i, this.unitAvg[u] as number), hi);
      return;
    }
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let count = 0;
    const every = !this.anySampled(i);
    for (let j = 0; j < n; j++) {
      if (!every && !this.sampled(i, j)) continue;
      const v = this.readingOf(i, this.unitAt[u * this.maxRows + j] as number);
      sum += v;
      count++;
      if (v < low) low = v;
      if (v > high) high = v;
    }
    this.set(i, low, sum / count, high);
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
