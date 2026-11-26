/**
 * `query_history` for the mock transport: deterministic buckets around each
 * series' sample value, with the scenario's gaps cut out (slots inside a gap
 * are absent, never zero). A bucket summarises its series over the seconds
 * it covers on the live rows' clock (`history-buckets.ts`), so a wide
 * bucket's max keeps the spikes its average smooths out.
 */

import {
  type Gap,
  HISTORY_RECENT_MS,
  HISTORY_TIERS,
  type HistoryPage,
  type HistoryPoint,
  type HistoryRequest,
  type HostVitals,
  METRIC_MODULES,
  type RemoteHostRecord,
  type SeriesStats,
  type Tier,
} from "@core/generated/types";
import { ceilTo, DAY_MS, floorTo, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import type { MockTransport, MockTransportOptions } from "./contracts";
import { MOCK_HOST_ID, type ScenarioFlags } from "./fixtures";
import type { SeriesSpec } from "./generator";
import { HistoryBuckets } from "./history-buckets";
import { mockBuckets } from "./protocol";
import type { MockRing } from "./ring";
import { rng, seedOf } from "./rng";
import { holdMs, matches } from "./series";

/** Seed the phone's demo measurements by host and metric. */
export function demoMetricScale(host: string, metric: string): number {
  const random = rng(seedOf(`${host}:${metric}`))();
  switch (metric) {
    case "cpu.total":
      return 0.6 + 1.3 * random;
    case "mem.used":
      return 0.65 + 0.65 * random;
    case "net.rx_total":
    case "net.tx_total":
      return 0.25 + 3 * random;
    default:
      return 1;
  }
}

const PHONE_DEMO_HOST = Symbol("phone demo host");
type DemoOptions = MockTransportOptions & { [PHONE_DEMO_HOST]?: string };

/** Pass these options to createMockTransport for a phone demo or scenario. */
export function phoneDemoOptions(
  options: MockTransportOptions,
  host = MOCK_HOST_ID
): MockTransportOptions {
  const tagged: DemoOptions = { ...options, [PHONE_DEMO_HOST]: host };
  return tagged;
}

function phoneDemoHost(options: DemoOptions) {
  const scenarios = options.scenarios ?? [];
  // The existing phone entry combines these two presets.
  const existingPreset =
    scenarios.includes("hosts-dashboard") &&
    scenarios.includes("host-incompatible");
  return options[PHONE_DEMO_HOST] ?? (existingPreset ? MOCK_HOST_ID : null);
}

const demoHosts = new WeakMap<object, string>();

export const demoHostOf = (remotes?: object) =>
  (remotes && demoHosts.get(remotes)) ?? null;

/** Apply the same host magnitudes to the ring backfill and its future samples. */
export function seedDemoRing(
  ring: MockRing,
  remotes: object,
  options: DemoOptions
) {
  const host = phoneDemoHost(options);
  if (host === null) return;
  demoHosts.set(remotes, host);
  const scales = ring.gen.keys.map(({ metric }) =>
    demoMetricScale(host, metric)
  );
  const scale = (value: number | null, index: number) =>
    value === null ? null : value * (scales[index] ?? 1);
  ring.rows = ring.rows.map((row) => ({
    ...row,
    values: row.values.map(scale),
  }));
  const sample = ring.gen.next.bind(ring.gen);
  ring.gen.next = (land, atMs) => {
    const row = sample(land, atMs);
    return { ...row, values: row.values.map(scale), held: row.held.map(scale) };
  };
}

export function demoVitals(
  host: string | null,
  vitals: HostVitals
): HostVitals {
  if (host === null) return vitals;
  const scale = (metric: string, value: number | null) =>
    value === null ? null : value * demoMetricScale(host, metric);
  return {
    ...vitals,
    cpu_pct: scale("cpu.total", vitals.cpu_pct),
    memory_pct: scale("mem.used", vitals.memory_pct),
    net_rx_bps: scale("net.rx_total", vitals.net_rx_bps),
    net_tx_bps: scale("net.tx_total", vitals.net_tx_bps),
  };
}

/** The NAS fixture has a working full stream but stops delivering compact summaries. */
function staleDemoPeer(peer: MockTransport): MockTransport {
  return {
    ...peer,
    subscribeLive(id, receive, options) {
      if (options?.backfillMs !== 0 || options.minPeriodMs !== 5_000)
        return peer.subscribeLive(id, receive, options);
      return peer.subscribeLive(
        id,
        (message) => {
          if (message.kind !== "frame") receive(message);
        },
        options
      );
    },
  };
}

export function seedDemoPeer(
  remotes: object,
  { config: { id: host }, status }: RemoteHostRecord,
  createPeer: (options: MockTransportOptions) => MockTransport,
  options: MockTransportOptions
): MockTransport {
  if (demoHostOf(remotes) === null) return createPeer(options);
  status.vitals = demoVitals(host, status.vitals);
  if (status.last_seen_ms !== null)
    status.last_seen_ms += status.clock_offset_ms ?? 0;
  const peer = createPeer(phoneDemoOptions(options, host));
  return host === "remote-nas" ? staleDemoPeer(peer) : peer;
}

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
  intervalMs: number,
  anchorMs = nowMs
): HistoryPage {
  const tier =
    req.tier !== "auto"
      ? req.tier
      : req.to_ms - req.from_ms <= S10.kept_ms
        ? "s10"
        : "m1";
  const page = mockHistory(
    { ...req, tier },
    specs,
    [],
    nowMs,
    intervalMs,
    anchorMs
  );
  const kept = nowMs - MOCK_RECENT_MS;
  return {
    ...page,
    series: page.series.map((s) => ({
      ...s,
      points: s.points.filter((p) => p.t + page.bucket_ms > kept),
    })),
  };
}

/**
 * `query_history` over `specs`, with the shapes' clock starting at
 * `anchorMs` (the ring's start, `MockGenerator.anchorMs`).
 */
export function mockHistory(
  req: HistoryRequest,
  specs: readonly SeriesSpec[],
  gaps: readonly Gap[],
  nowMs: number,
  intervalMs: number,
  anchorMs = nowMs
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

  const wanted = specs.flatMap((s, i) =>
    req.selectors.some((sel) => matches(s.key, sel)) ? [i] : []
  );
  const buckets = new HistoryBuckets(specs, wanted, step, anchorMs, intervalMs);
  const points = wanted.map((): HistoryPoint[] => []);
  for (let t = start; t < req.to_ms && t <= nowMs; t += step) {
    if (inGap(t)) continue;
    buckets.fill(t);
    wanted.forEach((i, j) => {
      points[j]?.push(buckets.point(i, t));
    });
  }
  const series = wanted.map((i, j) => {
    const s = specs[i] as SeriesSpec;
    return {
      key: s.key,
      points: points[j] ?? [],
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
