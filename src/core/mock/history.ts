/**
 * `query_history` for the mock transport: deterministic buckets around each
 * series' sample value, with the scenario's gaps cut out (slots inside a gap
 * are absent, never zero).
 */

import {
  type Gap,
  HISTORY_RECENT_MS,
  HISTORY_TIERS,
  type HistoryPage,
  type HistoryPoint,
  type HistoryRequest,
  METRIC_MODULES,
  type SeriesStats,
  type Tier,
} from "@core/generated/bindings";
import { seriesKeyString } from "@core/series-key";
import { ceilTo, DAY_MS, floorTo, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import type { ScenarioFlags } from "./fixtures";
import type { SeriesSpec } from "./generator";
import { mockBuckets } from "./protocol";
import { rng, seedOf } from "./rng";
import { holdMs, matches } from "./series";

const MIN = MINUTE_MS;
const HOUR = HOUR_MS;
const DAY = DAY_MS;

/**
 * The 29 nights before the last one, for the 7d and 30d ranges: each a sleep
 * of 5 to 8 hours starting within an hour of the same clock time, all ending
 * more than a day ago so the 24h range keeps its one band. Night 20
 * is a weekend away (one 34-hour sleep covering night 19 too), and two
 * afternoons have multi-hour holes for other reasons: StatGlass not running
 * (day 3, inside the 7d range) and paused (day 12).
 */
function pastNights(nowMs: number): Gap[] {
  const r = rng(20261004);
  const gaps: Gap[] = [];
  for (let d = 29; d >= 1; d--) {
    const jitter = (r() - 0.5) * 2 * HOUR;
    const length = 5 * HOUR + r() * 3 * HOUR;
    if (d === 19) continue;
    const start =
      Math.round((nowMs - 18 * HOUR - d * DAY + jitter) / MIN) * MIN;
    const end = start + (d === 20 ? 34 * HOUR : Math.round(length / MIN) * MIN);
    gaps.push({ start_ms: start, end_ms: end, module: null, reason: "sleep" });
    const afternoon = start + 12 * HOUR;
    if (d === 3) {
      gaps.push({
        start_ms: afternoon,
        end_ms: afternoon + 4 * HOUR + 30 * MIN,
        module: null,
        reason: "app_not_running",
      });
    } else if (d === 12) {
      gaps.push({
        start_ms: afternoon,
        end_ms: afternoon + 3 * HOUR,
        module: null,
        reason: "paused",
      });
    }
  }
  return gaps;
}

/**
 * An overnight sleep ("Asleep 5h 15m · no samples"), and the nights before
 * it (`pastNights`). With the sleep-gap scenario, also a short one inside the last hour ("Asleep 11:02–11:31").
 */
export function mockGaps(flags: ScenarioFlags, nowMs: number): Gap[] {
  const gaps: Gap[] = [
    ...pastNights(nowMs),
    {
      start_ms: nowMs - 18 * HOUR,
      end_ms: nowMs - 18 * HOUR + 5 * HOUR + 15 * MIN,
      module: null,
      reason: "sleep",
    },
  ];
  if (flags.sleepGap) {
    gaps.push({
      start_ms: nowMs - 52 * MIN,
      end_ms: nowMs - 23 * MIN,
      module: null,
      reason: "sleep",
    });
  }
  if (flags.paused) {
    gaps.push({
      start_ms: nowMs - 2 * MIN,
      end_ms: null,
      module: null,
      reason: "paused",
    });
  }
  return gaps;
}

type StoredTier = Extract<Tier, "s10" | "m1" | "m15">;

const [S10, M1, M15] = HISTORY_TIERS;

const TIER_BASE: Record<StoredTier, number> = {
  s10: S10.bucket_ms,
  m1: M1.bucket_ms,
  m15: M15.bucket_ms,
};

/** The store's `m1_rolled` cut: the quarter at or before the minutes' window. */
function rollCut(nowMs: number): number {
  const q = M15.bucket_ms;
  return floorTo(nowMs - M1.kept_ms, q);
}

/**
 * The store's `TierChoice::Auto` (D-076): S10 while a range no longer than
 * its 24 h retention starts inside it, M15 when the start is more than one
 * quarter before the roll cut, else M1. The quarter of slack is the
 * store's: a 7-day range ending now stays on minutes.
 */
function mockTier(req: HistoryRequest, nowMs: number): StoredTier {
  if (req.tier !== "auto") return req.tier;
  if (
    req.to_ms - req.from_ms <= S10.kept_ms &&
    req.from_ms >= nowMs - S10.kept_ms
  )
    return "s10";
  return rollCut(nowMs) - req.from_ms > M15.bucket_ms ? "m15" : "m1";
}

/**
 * `HistorySeries.hold_ms` (D-092): the hold of the slowest period the series
 * is sampled at (tray-only's idle cadence or the window's), or the page's
 * bucket if that is wider, as `LiveHub::history_hold_ms` computes it.
 */
function historyHoldMs(spec: SeriesSpec, intervalMs: number, bucketMs: number) {
  const period = Math.max(spec.cadence, spec.idleCadence) * intervalMs;
  return Math.max(holdMs(period), bucketMs);
}

/** How far back the engine keeps rows the store may not have. */
const MOCK_RECENT_MS = HISTORY_RECENT_MS;

/**
 * History unavailable: Rust answers from the engine's recent rows
 * alone (`history_recent`), with no gaps. A fixed tier is read as asked;
 * Auto is 10 s buckets for a range S10 keeps, else minutes. The slots stay
 * on the range's own grid; only the rows the engine keeps have values.
 */
export function mockRecentHistory(
  req: HistoryRequest,
  specs: readonly SeriesSpec[],
  nowMs: number,
  intervalMs: number
): HistoryPage {
  const tier =
    req.tier !== "auto"
      ? req.tier
      : req.to_ms - req.from_ms <= S10.kept_ms
        ? "s10"
        : "m1";
  const page = mockHistory({ ...req, tier }, specs, [], nowMs, intervalMs);
  const kept = nowMs - MOCK_RECENT_MS;
  return {
    ...page,
    series: page.series.map((s) => ({
      ...s,
      points: s.points.filter((p) => p.t + page.bucket_ms > kept),
    })),
  };
}

export function mockHistory(
  req: HistoryRequest,
  specs: readonly SeriesSpec[],
  gaps: readonly Gap[],
  nowMs: number,
  intervalMs: number
): HistoryPage {
  const tier = mockTier(req, nowMs);
  // The store's merge (`Reader::history`) of the tier's buckets.
  const { first, step } = mockBuckets(
    req.from_ms,
    req.to_ms,
    TIER_BASE[tier],
    req.max_points
  );
  // Minutes older than the roll cut are gone (D-076): an `m1` read there
  // comes back empty, as the store's does.
  const floor = tier === "m1" ? rollCut(nowMs) : Number.NEGATIVE_INFINITY;
  const start = first + Math.max(0, Math.ceil((floor - first) / step)) * step;
  const inGap = (t: number) =>
    gaps.some((g) => t + step > g.start_ms && t < (g.end_ms ?? Infinity));

  // A wider bucket's min and max span more seconds, so they sit further from
  // its average: x1 at 10 s, about x1.8 at 1 min, x3 from 30 min, so the
  // envelope on 7d and 30d reads as one.
  const spread = Math.min(3, 1 + Math.log10(step / 10_000));

  const series = specs
    .filter((s) => req.selectors.some((sel) => matches(s.key, sel)))
    .map((s) => {
      const r = rng(seedOf(seriesKeyString(s.key)));
      const amp = s.noise || Math.abs(s.base) * 0.05;
      const points: HistoryPoint[] = [];
      for (let t = start; t < req.to_ms && t <= nowMs; t += step) {
        const wave = Math.sin(t / (3 * HOUR)) * 0.6 + (r() - 0.5) * 0.8;
        if (inGap(t)) continue;
        const avg = clamp(s.base + wave * amp, s);
        points.push({
          t,
          avg,
          min: clamp(avg - amp * 0.4 * spread * r(), s),
          max: clamp(avg + amp * 0.6 * spread * r(), s),
        });
      }
      return {
        key: s.key,
        points,
        hold_ms: historyHoldMs(s, intervalMs, step),
      };
    });

  return {
    tier,
    bucket_ms: step,
    series,
    gaps: gaps.filter(
      (g) => g.start_ms < req.to_ms && (g.end_ms ?? Infinity) > req.from_ms
    ),
  };
}

function clamp(v: number, s: SeriesSpec): number {
  const c = Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, v));
  return Math.round(c * 1000) / 1000;
}

/**
 * `query_series_stats` as `history.rs` computes it: per metric, each bucket's
 * average weighted by the time it covers, from the bucket the range starts in
 * to the end of the one it ends in, cut at `now`, less the gaps that apply to
 * the metric's module. A bucket with no reading counts nothing.
 */
export function mockSeriesStats(
  host: string,
  metrics: readonly string[],
  fromMs: number,
  toMs: number,
  now: number,
  history: (req: HistoryRequest) => HistoryPage
): SeriesStats {
  const finest =
    HISTORY_TIERS.find((t) => t.tier === "s10")?.bucket_ms ?? 10_000;
  const page = history({
    host,
    selectors: metrics.map((metric) => ({ metric, labels: [] })),
    from_ms: fromMs,
    to_ms: toMs,
    tier: "auto",
    max_points: Math.floor((toMs - fromMs) / finest) + 2,
  });
  const width = Math.max(1, page.bucket_ms);
  const from = fromMs - (fromMs % width);
  const to = Math.max(from, Math.min(ceilTo(toMs, width), now));
  return {
    from_ms: from,
    to_ms: to,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing deterministic fixture scenario logic; split by scenario before removing this local exception (architecture package J).
    metrics: metrics.map((metric) => {
      const module = (METRIC_MODULES as Record<string, string>)[metric];
      const gaps = page.gaps
        .filter((g) => g.module === null || g.module === module)
        .map((g) => [g.start_ms, g.end_ms ?? now] as const)
        .sort((a, b) => a[0] - b[0]);
      const measured = (a: number, b: number) => {
        let covered = 0;
        let cursor = a;
        for (const [s0, e0] of gaps) {
          const s = Math.max(s0, cursor);
          const e = Math.min(e0, b);
          if (e > s) {
            covered += e - s;
            cursor = e;
          }
        }
        return Math.max(0, b - a - covered);
      };
      let measuredMs = 0;
      let weighted = 0;
      let max: number | null = null;
      for (const s of page.series) {
        if (s.key.metric !== metric) continue;
        for (const p of s.points) {
          const ms = measured(Math.max(p.t, from), Math.min(p.t + width, to));
          if (ms > 0 && p.avg !== null) {
            measuredMs += ms;
            weighted += p.avg * ms;
            if (p.max !== null)
              max = max === null ? p.max : Math.max(max, p.max);
          }
        }
      }
      const avg = measuredMs > 0 ? weighted / measuredMs : null;
      return {
        metric,
        measured_ms: measuredMs,
        avg,
        max,
        integral: avg === null ? 0 : (Math.max(0, avg) * measuredMs) / 1000,
      };
    }),
  };
}
