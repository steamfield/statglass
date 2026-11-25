import {
  type Event,
  HISTORY_MAX_ANSWER_BYTES,
  HISTORY_MAX_CORE_SERIES,
  HISTORY_MAX_EVENTS,
  HISTORY_MAX_POINTS,
  HISTORY_MAX_SERIES,
  HISTORY_TIERS,
  type HistoryPage,
  type HistoryPoint,
  type HistoryRequest,
  type HostHistoryPage,
  type HostHistoryRequest,
  METRIC_MODULES,
  type Module,
  type SeriesHistoryStats,
} from "../generated/types";
import { floorTo, MINUTE_MS } from "../time-grid";

/** One sampler tick: the bucket still filling is not complete yet. */
const SAMPLER_TICK_MS = 1_000;
const SUMMARY_METRICS = new Set([
  "cpu.total",
  "mem.used",
  "net.rx_total",
  "net.tx_total",
]);

import type { PhoneQueries, Transport } from "../transport";
import { MOCK_HOST_ID } from "./fixtures";
import { demoHostOf, demoMetricScale } from "./history";
import { fail, invalid, mockBuckets, ok, rangeError } from "./protocol";
import type { MockRemotes } from "./remote";

function historyTier(from: number, to: number, now: number, points: number) {
  const target = (to - from) / points;
  const retained = HISTORY_TIERS.filter(
    ({ kept_ms }) => kept_ms === null || from >= now - kept_ms
  );
  return (
    retained.filter(({ bucket_ms }) => bucket_ms <= target).at(-1) ??
    retained[0] ??
    HISTORY_TIERS[2]
  );
}

function eventModule({ detail }: Event): Module | undefined {
  switch (detail.kind) {
    case "fans_ramped":
    case "thermal_state":
    case "power_spike":
      return "power";
    case "sustained_process":
      return "cpu";
    case "alert": {
      const { cause } = detail;
      if (cause.type === "threshold")
        return METRIC_MODULES[cause.metric as keyof typeof METRIC_MODULES];
      if (cause.type === "process_cpu") return "cpu";
      if (cause.type === "thermal_state") return "power";
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Each unmerged series retains its own duration-weighted average and peak, plus
 * the measured time and the average times the measured seconds (range totals).
 */
function seriesStats(
  { series, bucket_ms: width }: HistoryPage,
  from: number,
  to: number
): SeriesHistoryStats[] {
  return series.map(({ key, points }) => {
    let duration = 0;
    let sum = 0;
    let peak: number | null = null;
    for (const { t, avg, max } of points) {
      const covered = Math.min(t + width, to) - Math.max(t, from);
      if (covered <= 0 || avg === null) continue;
      duration += covered;
      sum += avg * covered;
      if (max !== null) peak = Math.max(max, peak ?? max);
    }
    const measured = duration > 0;
    return {
      key,
      avg: measured ? sum / duration : null,
      peak,
      measured_ms: duration,
      integral: measured ? sum / 1000 : null,
    };
  });
}

/** Bound the fixture's wire size without introducing a CBOR encoder to the mock. */
function exceedsAnswerBudget(page: HostHistoryPage) {
  const { series, ...rest } = page;
  const metadata = series.map(({ points, ...fields }) => ({
    ...fields,
    count: points.length,
  }));
  // One array header, an i64 and three f64 values per point.
  const pointBytes = series.reduce(
    (bytes, s) => bytes + s.points.length * 37,
    0
  );
  return (
    pointBytes + 3 * JSON.stringify({ ...rest, series: metadata }).length >
    HISTORY_MAX_ANSWER_BYTES
  );
}

function historyRead(request: HostHistoryRequest, now: number) {
  const { host, series, from_ms, to_ms, max_points } = request;
  const to = to_ms ?? now;
  const error = rangeError(from_ms, to);
  if (error) return invalid(error);
  if (series.length === 0) return invalid("empty selectors");
  const unknown = series.find(
    ({ metric }) => !Object.hasOwn(METRIC_MODULES, metric)
  );
  if (unknown) return invalid(`${unknown.metric} is not in the catalog`);

  const budget = Math.min(HISTORY_MAX_POINTS, Math.max(1, max_points));
  const limit = series.every(({ metric }) => metric === "cpu.load")
    ? HISTORY_MAX_CORE_SERIES
    : HISTORY_MAX_SERIES;
  const tier = historyTier(from_ms, to, now, budget);
  const read: HistoryRequest = {
    host,
    selectors: series.slice(0, limit),
    from_ms,
    to_ms: to,
    tier: tier.tier,
    max_points: Math.ceil((to - from_ms) / tier.bucket_ms) + 1,
  };
  return ok({ read, budget, limit, bucketMs: tier.bucket_ms });
}

function mergePoints(
  points: readonly HistoryPoint[],
  first: number,
  step: number
) {
  const merged: (HistoryPoint & { avg: number })[] = [];
  let count = 0;
  for (const { t, avg, min, max } of points) {
    if (avg === null) continue;
    const slot = first + floorTo(t - first, step);
    const last = merged.at(-1);
    if (!last || last.t !== slot) {
      merged.push({ t: slot, avg, min, max });
      count = 1;
      continue;
    }
    count++;
    last.avg += (avg - last.avg) / count;
    if (min !== null) last.min = Math.min(last.min ?? min, min);
    if (max !== null) last.max = Math.max(last.max ?? max, max);
  }
  return merged;
}

/** Merge the generated measurements again if the byte ceiling requires it. */
function boundedChartPage(
  page: HostHistoryPage,
  from: number,
  to: number,
  budget: number
) {
  let maxPoints = budget;
  let clamped = page.clamped;
  for (;;) {
    const { first, step } = mockBuckets(from, to, page.bucket_ms, maxPoints);
    const series =
      step === page.bucket_ms
        ? page.series
        : page.series.map((entry) => ({
            ...entry,
            points: mergePoints(entry.points, first, step),
          }));
    const chart = { ...page, series, bucket_ms: step, clamped };
    if (maxPoints === 1 || !exceedsAnswerBudget(chart)) return chart;
    clamped = [...page.clamped, { kind: "bytes" }];
    maxPoints = Math.max(1, Math.floor(maxPoints / 2));
  }
}

async function readLocalHistory(
  queries: Pick<Transport, "queryHistory" | "queryEvents">,
  request: HostHistoryRequest,
  snapshot: number,
  demo: boolean
) {
  const planned = historyRead(request, snapshot);
  if (planned.status === "error") return planned;
  const { read, budget, limit, bucketMs } = planned.data;
  const { host, from_ms, to_ms } = read;
  const [raw, recorded] = await Promise.all([
    queries.queryHistory(read),
    request.events_for === null
      ? ok<Event[]>([])
      : queries.queryEvents(host, from_ms, to_ms),
  ]);
  if (raw.status === "error") return raw;
  if (recorded.status === "error") return recorded;

  const clamped: HostHistoryPage["clamped"] = [];
  if (request.max_points > HISTORY_MAX_POINTS) clamped.push({ kind: "points" });
  if (request.series.length > limit || raw.data.series.length > limit)
    clamped.push({ kind: "series" });
  const matched = recorded.data.filter(
    (event) => eventModule(event) === request.events_for
  );
  if (matched.length > HISTORY_MAX_EVENTS) clamped.push({ kind: "events" });
  const page = { ...raw.data, series: raw.data.series.slice(0, limit) };
  const through = Math.min(to_ms, snapshot);
  const compactHistory =
    demo &&
    request.events_for === null &&
    to_ms - from_ms === 30 * MINUTE_MS &&
    request.series.length === SUMMARY_METRICS.size &&
    request.series.every(
      ({ metric, labels }) => labels.length === 0 && SUMMARY_METRICS.has(metric)
    );
  const answer = {
    ...page,
    // The compact fixture seeds through now so the first summary can follow
    // directly. Other reads emulate Rust's last closed source bucket.
    complete_to_ms: Math.max(
      from_ms,
      compactHistory
        ? through
        : Math.min(to_ms, floorTo(snapshot - SAMPLER_TICK_MS, bucketMs))
    ),
    events: matched.slice(-HISTORY_MAX_EVENTS),
    stats: seriesStats(page, from_ms, through),
    clamped,
  };
  return ok(boundedChartPage(answer, from_ms, to_ms, budget));
}

export function createMockHostHistory(
  queries: Pick<Transport, "queryHistory" | "queryEvents">,
  now = Date.now,
  remotes?: MockRemotes["remotes"]
): PhoneQueries["hostHistory"] {
  return async (request) => {
    const remote = remotes?.get(request.host);
    if (!remote) {
      const host = demoHostOf(remotes);
      const result = await readLocalHistory(
        queries,
        request,
        now(),
        host !== null
      );
      return host === null ? result : demoHistory(result, host);
    }
    if (remote.record.status.state !== "connected")
      return fail({
        kind: "remote_unreachable",
        message: "Host is disconnected",
      });
    return remote.peer.hostHistory({
      ...request,
      host: MOCK_HOST_ID,
    });
  };
}

function demoHistory(
  result: Awaited<ReturnType<PhoneQueries["hostHistory"]>>,
  host: string
) {
  if (result.status === "error") return result;
  const scale = (metric: string) => {
    const factor = demoMetricScale(host, metric);
    return (value: number | null) => (value === null ? null : value * factor);
  };
  return ok({
    ...result.data,
    series: result.data.series.map((series) => {
      const sample = scale(series.key.metric);
      return {
        ...series,
        points: series.points.map(({ t, avg, min, max }) => ({
          t,
          avg: sample(avg),
          min: sample(min),
          max: sample(max),
        })),
      };
    }),
    stats: result.data.stats.map((stat) => {
      const sample = scale(stat.key.metric);
      return {
        ...stat,
        avg: sample(stat.avg),
        peak: sample(stat.peak),
        integral: sample(stat.integral),
      };
    }),
  });
}
