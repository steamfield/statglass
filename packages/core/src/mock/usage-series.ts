/**
 * `query_usage_series` for the mock transport: the apps `mockUsageByApp`
 * ranks first, each as one value per 10 s bucket. The mock keeps no per-bucket
 * history, so each bucket is the app's range average shaped by its kind of
 * load (`burst.ts`: CPU idles with spikes, memory steps, disk bursts), scaled
 * so the shape averages to 1 over a week.
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
import { longRunMean, type Shape, Shaper, type SpanStats } from "./burst";
import { seedOf } from "./rng";

/** The burst profile of each usage key. */
const SHAPE_OF: Record<UsageKey, Shape> = {
  cpu: "load",
  gpu: "load",
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
      const seed = seedOf(a.name);
      const shaper = new Shaper(SHAPE_OF[by], seed);
      const scale = avg / longRunMean(SHAPE_OF[by], seed);
      const span: SpanStats = { min: 0, avg: 0, max: 0 };
      return {
        name: a.name,
        avg,
        values: Array.from({ length: n }, (_, i) => {
          if (!covered(i)) return null;
          // Keyed by the bucket's start, so a bucket reads the same in any range.
          const t = (from + i * BUCKET_MS) / 1000;
          const m = shaper.stats(t, t + BUCKET_MS / 1000, span).avg;
          return Math.max(0, scale * m);
        }),
      };
    }),
  };
}
