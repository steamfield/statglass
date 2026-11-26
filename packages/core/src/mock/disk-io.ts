/**
 * Typed command fixture: models server-side weighted request aggregation.
 * Each device bursts as its live series do (`burst.ts`), on the same seeds
 * and clock: a bucket's throughput and completions are its device's burst
 * averaged over the bucket's seconds, so the page agrees with the device's
 * `disk.read` history. Request time per completion stays at its sample value,
 * and an all-device point weights it by each device's completions.
 */

import type {
  DiskIoDevices,
  DiskIoPage,
  DiskIoPoint,
  DiskIoRequest,
  Gap,
} from "@core/generated/types";
import { floorTo, MINUTE_MS } from "@core/time-grid";
import { Shaper, type SpanStats, shapeSecond } from "./burst";
import type { ScenarioName } from "./fixtures";
import { mockBuckets } from "./protocol";
import { diskSeed } from "./series-shapes";

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

/** A device's sample rates in one direction: bytes/s, completions/s, ms per completion. */
type Rates = [bps: number, ops: number, requestMs: number];

/** One direction of a device: its sample rates and its live burst. */
interface Transfers {
  bps: number;
  ops: number;
  requestMs: number;
  shaper: Shaper;
}

/** Read and write transfers of the devices a request covers, as the live specs have them. */
function transfersOf(
  request: DiskIoRequest,
  scenarios: readonly ScenarioName[]
): { read: Transfers[]; write: Transfers[] } {
  const comparison = scenarios.includes("disk-io-comparison");
  type Device = { index: number; read: Rates; write: Rates };
  const internal: Device = {
    index: 0,
    read: [comparison ? 420e6 : 220e6, 5000, 0.15],
    write: [comparison ? 90e6 : 48e6, 1200, 0.3],
  };
  const external: Device = {
    index: 1,
    read: [4e6, 80, 42],
    write: [1e6, 30, 65],
  };
  const devices = (comparison ? [internal, external] : [internal]).filter(
    ({ index }) =>
      (request.device === null && comparison) ||
      index === (request.device === "disk7" ? 1 : 0)
  );
  const idle = scenarios.includes("disk-io-no-ops") ? 0 : 1;
  const side = (write: boolean): Transfers[] =>
    devices.map((device) => {
      const [bps, ops, requestMs] = write ? device.write : device.read;
      return {
        bps: idle * bps,
        ops: idle * ops,
        requestMs,
        shaper: new Shaper("disk", diskSeed(device.index, write)),
      };
    });
  return { read: side(false), write: side(true) };
}

/** One direction over `[a, b)` shape seconds: bytes and completions per second, and ms per completion. */
function bucketOf(
  transfers: readonly Transfers[],
  a: number,
  b: number,
  span: SpanStats
): { bps: number; ops: number; requestMs: number | null } {
  let bps = 0;
  let ops = 0;
  let time = 0;
  for (const t of transfers) {
    const burst = t.shaper.stats(a, b, span).avg;
    bps += t.bps * burst;
    ops += t.ops * burst;
    time += t.ops * burst * t.requestMs;
  }
  return { bps, ops, requestMs: ops > 0 ? time / ops : null };
}

/** The gaps a disk page shows: the host's, and the `disk-io-gap` scenario's. */
function diskGaps(
  request: DiskIoRequest,
  scenarios: readonly ScenarioName[],
  sharedGaps: readonly Gap[]
): Gap[] {
  return [
    ...sharedGaps.filter((g) => g.module === null || g.module === "disk"),
    ...(scenarios.includes("disk-io-gap")
      ? [
          {
            start_ms: request.to_ms - 90_000,
            end_ms: request.to_ms - MINUTE_MS,
            module: "disk" as const,
            reason: "sleep" as const,
          },
        ]
      : []),
  ].filter(
    (g) =>
      g.start_ms < request.to_ms && (g.end_ms ?? Infinity) > request.from_ms
  );
}

/**
 * `query_disk_io` with the shapes' clock starting at `anchorMs` (the ring's
 * start, `MockGenerator.anchorMs`).
 */
export function mockDiskIo(
  request: DiskIoRequest,
  scenarios: readonly ScenarioName[],
  sharedGaps: readonly Gap[] = [],
  anchorMs = request.to_ms
): DiskIoPage {
  const bucket = bucketWidth(request);
  const unsupported = scenarios.includes("disk-io-unavailable");
  const gaps = diskGaps(request, scenarios, sharedGaps);
  const { read, write } = transfersOf(request, scenarios);
  const span: SpanStats = { min: 0, avg: 0, max: 0 };
  const pointAt = (t: number): DiskIoPoint => {
    const missing = gaps.some(
      (g) => t + bucket > g.start_ms && t < (g.end_ms ?? Infinity)
    );
    const a = shapeSecond(t, anchorMs);
    const r = bucketOf(read, a, a + bucket / 1000, span);
    const w = bucketOf(write, a, a + bucket / 1000, span);
    const timed = !(missing || unsupported);
    return {
      t,
      read_bps: missing ? null : r.bps,
      write_bps: missing ? null : w.bps,
      read_ops_per_sec: timed ? r.ops : null,
      write_ops_per_sec: timed ? w.ops : null,
      read_request_ms: timed ? r.requestMs : null,
      write_request_ms: timed ? w.requestMs : null,
    };
  };
  const points: DiskIoPoint[] = [];
  let readBytes = 0;
  let writeBytes = 0;
  let coveredMs = 0;
  for (
    let t = floorTo(request.from_ms, bucket);
    t < request.to_ms;
    t += bucket
  ) {
    const p = pointAt(t);
    points.push(p);
    // A bucket outside a gap has both directions' bytes.
    if (p.read_bps === null || p.write_bps === null) continue;
    const ms =
      Math.min(t + bucket, request.to_ms) - Math.max(t, request.from_ms);
    coveredMs += ms;
    readBytes += (p.read_bps * ms) / 1000;
    writeBytes += (p.write_bps * ms) / 1000;
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
