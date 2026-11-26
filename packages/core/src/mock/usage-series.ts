/**
 * `query_usage_series` for the mock transport: the apps `mockUsageByApp`
 * ranks first, each as one value per 10 s bucket. The mock keeps no per-bucket
 * history, so each bucket is the app's range average shaped by its kind of
 * load (`burst.ts`: CPU idles with spikes, memory steps, disk bursts), scaled
 * so the measured buckets average to the app's range average.
 * Mirrors `usage.rs`: buckets before counting started or after the newest
 * sample read `null` (unmeasured), GPU reads `null` where it was never
 * measured, and every value is a rate in the key's unit.
 */

import type {
  AppUsage,
  UsageByApp,
  UsageKey,
  UsageSeries,
} from "@core/generated/types";
import { USAGE_BUCKET_MS as BUCKET_MS } from "@core/generated/types";
import { floorTo } from "@core/time-grid";
import { type Shape, Shaper, type SpanStats } from "./burst";
import { seedOf } from "./rng";

/** The burst profile of each usage key. */
const SHAPE_OF: Record<UsageKey, Shape> = {
  cpu: "load",
  gpu: "gpu",
  energy: "load",
  memory: "level",
  disk: "disk",
};

/** An app's range average in the series' unit for `by`. */
function averageOf(by: UsageKey, a: AppUsage, coveredMs: number): number {
  switch (by) {
    case "cpu":
      return a.cpu_avg_pct ?? 0;
    case "gpu":
      return a.gpu_avg_pct ?? 0;
    case "memory":
      return a.mem_avg_bytes;
    case "disk":
      return coveredMs > 0
        ? (((a.read_bytes ?? 0) + (a.write_bytes ?? 0)) * 1000) / coveredMs
        : 0;
    case "energy":
      return a.avg_w ?? 0;
  }
}

export function mockUsageSeries({
  byApp,
  by,
  sinceMs,
  latestMs,
}: {
  /** The ranked answer over the same range, `limit` already applied. */
  byApp: UsageByApp;
  by: UsageKey;
  /** When the mock started counting. */
  sinceMs: number;
  /** The newest process sample. */
  latestMs: number;
}): UsageSeries {
  const from = byApp.from_ms;
  const n = Math.max(0, Math.round((byApp.to_ms - from) / BUCKET_MS));
  const measured = by === "gpu" ? byApp.gpu_covered_ms > 0 : true;
  const covered = (i: number) => {
    const start = from + i * BUCKET_MS;
    return measured && start + BUCKET_MS > sinceMs && start < latestMs;
  };
  return {
    from_ms: from,
    bucket_ms: BUCKET_MS,
    since_ms: sinceMs,
    complete_to_ms: floorTo(latestMs, BUCKET_MS),
    latest_ms: latestMs,
    apps: byApp.apps.map((a) => {
      const avg = averageOf(by, a, byApp.covered_ms);
      const shaper = new Shaper(SHAPE_OF[by], seedOf(a.name));
      const span: SpanStats = { min: 0, avg: 0, max: 0 };
      // Keyed by the bucket's start, so a bucket's shape is the same in any range.
      const shape = Array.from({ length: n }, (_, i) => {
        if (!covered(i)) return null;
        const t = (from + i * BUCKET_MS) / 1000;
        return Math.max(0, shaper.stats(t, t + BUCKET_MS / 1000, span).avg);
      });
      const scale = avg / meanOf(shape);
      return {
        name: a.name,
        avg,
        values: shape.map((m) => (m === null ? null : scale * m)),
      };
    }),
  };
}

/** The mean of the measured values; 1 when none are, or all are zero. */
function meanOf(values: readonly (number | null)[]): number {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v === null) continue;
    sum += v;
    n++;
  }
  return n > 0 && sum > 0 ? sum / n : 1;
}
