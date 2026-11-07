import type { DockerHistoryPoint } from "@core/generated/bindings";
import { splitRuns } from "./gaps";

export type ComparisonMetric = "cpu" | "memory";
export interface SeriesVertex {
  x: number;
  y: number;
  time: number;
  value: number;
  partial: boolean;
}
export interface SeriesBand {
  x: number;
  width: number;
  minimumY: number;
  maximumY: number;
  partial: boolean;
}
export function pointValue(
  point: DockerHistoryPoint,
  metric: ComparisonMetric,
  statistic: "average" | "minimum" | "maximum" = "average"
): number | null {
  const measured =
    metric === "cpu" ? point.cpu_measured_ms : point.memory_measured_ms;
  if (!measured) return null;
  // Keep the statistic explicit and stable across every retention tier.
  const values =
    statistic === "average"
      ? point.metrics
      : statistic === "minimum"
        ? point.minimum
        : point.peak;
  return metric === "cpu" ? values.cpu_pct : values.working_set_bytes;
}
export function pointCovered(
  point: DockerHistoryPoint,
  metric: ComparisonMetric
) {
  return metric === "cpu" ? point.cpu_covered : point.memory_covered;
}
/** Timestamp geometry only: quality and metric semantics arrive from Rust (R-11/R-46). */
export function buildSeriesRuns(
  points: readonly DockerHistoryPoint[],
  metric: ComparisonMetric,
  from: number,
  to: number,
  width: number,
  height: number,
  ceiling: number
) {
  const span = Math.max(1, to - from);
  const bands: SeriesBand[] = [];
  // A missing value is a gap: null, so the runs break there.
  const vertices: ((SeriesVertex & { end: number }) | null)[] = [];
  for (const point of points) {
    if (point.time_ms < from || point.time_ms >= to) continue;
    const value = pointValue(point, metric);
    if (value === null) {
      vertices.push(null);
      continue;
    }
    const partial = !pointCovered(point, metric);
    const x = ((point.time_ms - from) / span) * width;
    vertices.push({
      x,
      y: height - (value / ceiling) * height,
      time: point.time_ms,
      value,
      partial,
      end: point.time_ms + point.duration_ms,
    });
    const minimum = pointValue(point, metric, "minimum");
    const maximum = pointValue(point, metric, "maximum");
    if (minimum !== null && maximum !== null) {
      bands.push({
        x,
        width: partial
          ? 0
          : ((Math.min(to, point.time_ms + point.duration_ms) - point.time_ms) /
              span) *
            width,
        minimumY: height - (minimum / ceiling) * height,
        maximumY: height - (maximum / ceiling) * height,
        partial,
      });
    }
  }
  // A partial bucket stands alone; covered ones join only where they touch.
  const split = splitRuns(
    vertices,
    (v) => v !== null,
    (a, b) => !a.partial && !b.partial && a.end === b.time
  ).map((run) => run.items.map(({ end: _end, ...vertex }) => vertex));
  const runs = split.filter((run) => run.length > 1);
  const dots = split.flatMap((run) => (run.length === 1 ? run : []));
  return { runs, dots, bands };
}
export interface RankedCandidate {
  id: string;
  value: number | null;
}
export function rankCandidates<T extends RankedCandidate>(
  candidates: readonly T[]
): T[] {
  return [...candidates].sort(
    (a, b) =>
      (b.value ?? -Infinity) - (a.value ?? -Infinity) ||
      a.id.localeCompare(b.id)
  );
}
export interface Membership {
  slots: Record<string, number>;
  streaks: Record<string, number>;
}
/** Stable slots survive re-ranking; three live evaluations are required for a replacement. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive logic; split when substantially changed (architecture refactor section 10).
export function nextMembership(
  previous: Membership,
  candidates: readonly RankedCandidate[],
  immediate: boolean,
  protectedIds: readonly string[] = []
): Membership {
  const ranked = rankCandidates(candidates);
  const count = ranked.length <= 6 ? ranked.length : 5;
  const available = new Set(ranked.map((row) => row.id));
  const slots = Object.fromEntries(
    Object.entries(previous.slots).filter(([id]) => available.has(id))
  );
  const streaks: Record<string, number> = {};
  if (immediate || ranked.length <= 6) {
    const protectedRows = ranked.filter(
      (row) => protectedIds.includes(row.id) && row.id in slots
    );
    const desired = new Set(
      [
        ...protectedRows,
        ...ranked.filter((row) => !protectedRows.includes(row)),
      ]
        .slice(0, count)
        .map((row) => row.id)
    );
    for (const id of Object.keys(slots)) if (!desired.has(id)) delete slots[id];
    for (const row of ranked.filter((r) => desired.has(r.id)))
      if (!(row.id in slots)) slots[row.id] = freeSlot(slots);
    return { slots, streaks };
  }
  while (Object.keys(slots).length > count) {
    const lowest = [...ranked]
      .reverse()
      .find((r) => r.id in slots && !protectedIds.includes(r.id));
    if (!lowest) break;
    delete slots[lowest.id];
  }
  for (const row of ranked) {
    if (row.id in slots) continue;
    if (Object.keys(slots).length < count) {
      slots[row.id] = freeSlot(slots);
      continue;
    }
    const lowest = [...ranked]
      .reverse()
      .find((r) => r.id in slots && !protectedIds.includes(r.id));
    if (!lowest || ranked.indexOf(row) >= ranked.indexOf(lowest)) continue;
    const key = `${row.id}:${lowest.id}`;
    streaks[key] = (previous.streaks[key] ?? 0) + 1;
    if (streaks[key] >= 3) {
      delete slots[lowest.id];
      slots[row.id] = freeSlot(slots);
      delete streaks[key];
    }
  }
  return { slots, streaks };
}
function freeSlot(slots: Record<string, number>) {
  const occupied = new Set(Object.values(slots));
  return [1, 2, 3, 4, 5, 6].find((slot) => !occupied.has(slot)) ?? 6;
}
export const seriesColor = (slot: number) => `var(--color-series-${slot})`;
