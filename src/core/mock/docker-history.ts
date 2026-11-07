import {
  DOCKER_BUCKET_MS,
  type DockerContainer,
  type DockerCoverage,
  type DockerHistoryPoint,
  type DockerHistoryRequest,
} from "@core/generated/bindings";
import { DAY_MS, floorTo, HOUR_MS } from "@core/time-grid";
import { engine, MiB } from "./docker-fixtures";
import { seedOf } from "./rng";
/** Shared generator: timestamp-positioned history with real gaps and partial buckets. */
export function mockHistoryPoints(
  request: DockerHistoryRequest,
  container: DockerContainer
): DockerHistoryPoint[] {
  const span = request.to_ms - request.from_ms;
  const tier =
    span <= HOUR_MS ? DOCKER_BUCKET_MS : span <= 7 * DAY_MS ? 60_000 : 900_000;
  const duration = Math.max(
    tier,
    Math.ceil(span / Math.max(1, request.max_points) / tier) * tier
  );
  const count = Math.min(request.max_points, Math.ceil(span / duration));
  const seed = seedOf(container.id);
  const base = container.metrics.cpu_pct ?? 20 + (seed % 65);
  const memory =
    container.metrics.working_set_bytes ?? (80 + (seed % 400)) * MiB;
  const from = floorTo(request.from_ms, duration);
  const gapStart = from + Math.floor(count / 3) * duration;
  return Array.from({ length: count }, (_, i): DockerHistoryPoint | null => {
    const time = from + i * duration;
    if (time >= gapStart && time < gapStart + 60_000) return null;
    if (container.lifecycle === "removed" && i >= count / 2) return null;
    const cpu = historyCpu(container.id, i, count, base, seed);
    const working = memory * (0.9 + 0.1 * Math.sin(i / 13 + seed));
    const partial =
      i === Math.floor(count * 0.65) || i === Math.floor(count * 0.8);
    const weight = partial ? Math.round(duration * 0.7) : duration - 1;
    const metrics = {
      ...container.metrics,
      cpu_pct: cpu,
      working_set_bytes: working,
    };
    const multiplier =
      duration > DOCKER_BUCKET_MS && i === Math.floor(count / 4)
        ? 3
        : 1.05 + ((seed + i) % 36) / 100;
    return {
      time_ms: time,
      duration_ms: duration,
      expected_ms: duration,
      cpu_measured_ms: weight,
      memory_measured_ms: weight,
      cpu_covered: !partial,
      memory_covered: !partial,
      metrics,
      peak: {
        ...metrics,
        cpu_pct: cpu * multiplier,
        working_set_bytes: working * multiplier,
      },
      minimum: {
        ...metrics,
        cpu_pct: cpu * 0.8,
        working_set_bytes: working * 0.8,
      },
      population_revision: 1,
      revision: i,
      explicit_limit_bytes: container.explicit_limit_bytes,
      engine_capacity_bytes: engine.capacity_bytes,
    };
  }).filter((point): point is DockerHistoryPoint => point !== null);
}

function historyCpu(
  id: string,
  i: number,
  count: number,
  base: number,
  seed: number
): number {
  if (i === 1) return 0;
  if (id === "removed-spike" && i === Math.floor(count / 4)) return 420;
  return Math.max(0, base * (0.75 + 0.25 * Math.sin(i / 6 + seed)));
}

/**
 * `mask_uncovered` in Rust's `projection.rs`: no point claims measured time
 * inside a collection or metrics gap of its container or of all containers
 * (`DockerCoverage::masks`; an engine-wide partial cycle masks nothing).
 */
export function maskUncovered(
  points: readonly DockerHistoryPoint[],
  coverage: readonly DockerCoverage[],
  containerId: string | null,
  toMs: number
): DockerHistoryPoint[] {
  const spans = coverage
    .filter(
      (g) =>
        (g.kind === "collection" || g.kind === "metrics") &&
        (g.container_id === null
          ? g.reason !== "partial_cycle"
          : g.container_id === containerId)
    )
    .map((g) => [g.start_ms, g.end_ms ?? toMs] as const)
    .sort((a, b) => a[0] - b[0]);
  return points.map((p) => {
    const end = p.time_ms + p.duration_ms;
    let gap = 0;
    let cursor = p.time_ms;
    for (const [s0, e0] of spans) {
      const s = Math.max(s0, cursor);
      const e = Math.min(e0, end);
      if (e > s) {
        gap += e - s;
        cursor = e;
      }
    }
    if (gap === 0) return p;
    const left = end - p.time_ms - gap;
    return {
      ...p,
      cpu_measured_ms: Math.min(p.cpu_measured_ms, left),
      memory_measured_ms: Math.min(p.memory_measured_ms, left),
      cpu_covered: false,
      memory_covered: false,
    };
  });
}
