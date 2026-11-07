import {
  type ComparisonMetric,
  pointCovered,
  pointValue,
} from "@core/chart-math/series-lines";
import type {
  DockerContainer,
  DockerCoverage,
  DockerHistoryPoint,
} from "@core/generated/bindings";
import { useMemo } from "react";
import {
  ChartTable,
  type ChartTableRow,
  type ChartTableStats,
} from "~/components/data-table";
import type { ComparisonSeries } from "./comparison-chart";

function stats(
  point: DockerHistoryPoint | undefined,
  metric: ComparisonMetric
): ChartTableStats | null {
  if (!point || pointValue(point, metric) === null) return null;
  return {
    min: pointValue(point, metric, "minimum"),
    avg: pointValue(point, metric, "average"),
    max: pointValue(point, metric, "maximum"),
    partial: !pointCovered(point, metric),
  };
}

/**
 * Each bucket any container has, with every container's reading in it, and
 * a row for each engine-wide gap (a container's own gaps read as missing).
 */
function comparisonRows(
  series: readonly ComparisonSeries[],
  times: readonly number[],
  metric: ComparisonMetric,
  gaps: readonly DockerCoverage[],
  from: number,
  to: number
): ChartTableRow[] {
  const bySeries = series.map(
    (s) => new Map(s.points.map((p) => [p.time_ms, p]))
  );
  const rows: ChartTableRow[] = times.map((t) => ({
    kind: "bucket",
    t,
    values: bySeries.map((points) => stats(points.get(t), metric)),
  }));
  for (const g of gaps) {
    if (g.container_id !== null) continue;
    if (g.start_ms >= to || (g.end_ms ?? Number.POSITIVE_INFINITY) <= from)
      continue;
    rows.push({ kind: "gap", t: Math.max(from, g.start_ms), label: g.label });
  }
  return rows;
}

/** The comparison chart's "Show as table", inline in its card. */
export function ComparisonValues({
  series,
  times,
  metric,
  gaps,
  from,
  to,
  bucketMs,
  displayName,
  format,
}: {
  series: readonly ComparisonSeries[];
  times: readonly number[];
  metric: ComparisonMetric;
  gaps: readonly DockerCoverage[];
  from: number;
  to: number;
  bucketMs: number;
  displayName: (container: DockerContainer) => string;
  format: (value: number | null) => string;
}) {
  const columns = useMemo(
    () =>
      series.map((s) => ({
        id: s.container.id,
        label: displayName(s.container),
        format,
      })),
    [series, displayName, format]
  );
  const rows = useMemo(
    () => comparisonRows(series, times, metric, gaps, from, to),
    [series, times, metric, gaps, from, to]
  );
  return (
    <ChartTable
      label="Container history values"
      series={columns}
      rows={rows}
      bucketMs={bucketMs}
      fromMs={from}
      toMs={to}
      surface="card"
      className="h-60"
    />
  );
}
