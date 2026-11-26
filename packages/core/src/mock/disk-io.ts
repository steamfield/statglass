/**
 * Typed command fixture: models server-side weighted request aggregation.
 * Throughput bursts as the live disk series do (`burst.ts`): each bucket is
 * the average of the burst shape over its seconds, on one seed per direction
 * so every device bursts together and keeps its ratio to the others.
 * Operation counts and request times stay at their sample values.
 */

import type {
  DiskIoDevices,
  DiskIoPage,
  DiskIoPoint,
  DiskIoRequest,
  Gap,
} from "@core/generated/types";
import { floorTo, MINUTE_MS } from "@core/time-grid";
import { Shaper, type SpanStats } from "./burst";
import type { ScenarioName } from "./fixtures";
import { mockBuckets } from "./protocol";
import { seedOf } from "./rng";

export function mockDiskDevices(
  scenarios: readonly ScenarioName[]
): DiskIoDevices {
  const comparison = scenarios.includes("disk-io-comparison");
  return {
    default_device: "disk3",
    devices: [
      {
        dev: "disk3",
        name: comparison
          ? "Internal SSD · High throughput, short requests"
          : "Apple SSD",
        internal: true,
        request_time_supported: !scenarios.includes("disk-io-unavailable"),
      },
      ...(comparison
        ? [
            {
              dev: "disk7",
              name: "External drive · Low throughput, slow requests",
              internal: false,
              request_time_supported: true,
            },
          ]
        : []),
    ],
  };
}

/**
 * `disk_io.rs`: the store's merge of 10 s buckets, widened by doubling until
 * the epoch-aligned runs from the one holding `from_ms` fit `max_points`.
 */
function bucketWidth(request: DiskIoRequest): number {
  const maxPoints = Math.max(1, request.max_points);
  let bucket = mockBuckets(
    request.from_ms,
    request.to_ms,
    10_000,
    maxPoints
  ).step;
  while (
    Math.ceil((request.to_ms - floorTo(request.from_ms, bucket)) / bucket) >
    maxPoints
  )
    bucket *= 2;
  return bucket;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing deterministic fixture scenario logic; split by scenario before removing this local exception (architecture package J).
export function mockDiskIo(
  request: DiskIoRequest,
  scenarios: readonly ScenarioName[],
  sharedGaps: readonly Gap[] = []
): DiskIoPage {
  const bucket = bucketWidth(request);
  const first = floorTo(request.from_ms, bucket);
  const points: DiskIoPoint[] = [];
  const idle = scenarios.includes("disk-io-no-ops");
  const unsupported = scenarios.includes("disk-io-unavailable");
  let readBytes = 0;
  let writeBytes = 0;
  const gapFrom = request.to_ms - 90_000;
  const gapTo = request.to_ms - MINUTE_MS;
  const gaps = [
    ...sharedGaps.filter((g) => g.module === null || g.module === "disk"),
    ...(scenarios.includes("disk-io-gap")
      ? [
          {
            start_ms: gapFrom,
            end_ms: gapTo,
            module: "disk" as const,
            reason: "sleep" as const,
          },
        ]
      : []),
  ].filter(
    (g) =>
      g.start_ms < request.to_ms && (g.end_ms ?? Infinity) > request.from_ms
  );
  let coveredMs = 0;
  const readShape = new Shaper("disk", seedOf("disk-io:read"));
  const writeShape = new Shaper("disk", seedOf("disk-io:write"));
  const span: SpanStats = { min: 0, avg: 0, max: 0 };
  for (let t = first; t < request.to_ms; t += bucket) {
    const missing = gaps.some(
      (g) => t + bucket > g.start_ms && t < (g.end_ms ?? Infinity)
    );
    const slow = request.device === "disk7";
    const all =
      request.device === null && scenarios.includes("disk-io-comparison");
    const readBurst = readShape.stats(t / 1000, (t + bucket) / 1000, span).avg;
    const writeBurst = writeShape.stats(
      t / 1000,
      (t + bucket) / 1000,
      span
    ).avg;
    const read = idle
      ? 0
      : (slow
          ? 4e6
          : scenarios.includes("disk-io-comparison")
            ? 420e6
            : 220e6) * readBurst;
    const write = idle
      ? 0
      : (slow ? 1e6 : scenarios.includes("disk-io-comparison") ? 90e6 : 48e6) *
        writeBurst;
    const readOps = idle ? 0 : slow ? 80 : 5000;
    const writeOps = idle ? 0 : slow ? 30 : 1200;
    const p: DiskIoPoint = {
      t,
      read_bps: missing ? null : read + (all && !idle ? 4e6 * readBurst : 0),
      write_bps: missing ? null : write + (all && !idle ? 1e6 * writeBurst : 0),
      read_ops_per_sec:
        missing || unsupported ? null : readOps + (all && !idle ? 80 : 0),
      write_ops_per_sec:
        missing || unsupported ? null : writeOps + (all && !idle ? 30 : 0),
      read_request_ms:
        missing || idle || unsupported
          ? null
          : all
            ? (5000 * 0.15 + 80 * 42) / 5080
            : slow
              ? 42
              : 0.15,
      write_request_ms:
        missing || idle || unsupported
          ? null
          : all
            ? (1200 * 0.3 + 30 * 65) / 1230
            : slow
              ? 65
              : 0.3,
    };
    const seconds =
      (Math.min(t + bucket, request.to_ms) - Math.max(t, request.from_ms)) /
      1000;
    if (!missing) coveredMs += seconds * 1000;
    if (p.read_bps !== null) readBytes += p.read_bps * seconds;
    if (p.write_bps !== null) writeBytes += p.write_bps * seconds;
    points.push(p);
  }
  return {
    tier: "s10",
    bucket_ms: bucket,
    from_ms: request.from_ms,
    to_ms: request.to_ms,
    read_covered_ms: coveredMs,
    write_covered_ms: coveredMs,
    points,
    read_bytes: points.some((p) => p.read_bps !== null) ? readBytes : null,
    write_bytes: points.some((p) => p.write_bps !== null) ? writeBytes : null,
    gaps,
  };
}
