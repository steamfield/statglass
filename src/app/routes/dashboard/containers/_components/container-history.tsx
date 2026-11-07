import { fittedCeiling, splitRuns } from "@core/chart-math";
import {
  cssPercent,
  formatBytes,
  formatDateTime,
  formatPercent,
  formatRate,
} from "@core/format";
import type {
  DockerEvent,
  DockerHistoryPage,
  DockerMetrics,
} from "@core/generated/bindings";
import { memo, useMemo } from "react";
import { SectionCard } from "~/components/section-card";
import { ChartFrame, ChartGrid, chartY } from "~/widgets/chart-frame";
import { GapEdgeDot } from "~/widgets/gap-edge-dot";
import { ceilingAxis, historyTicks } from "~/widgets/lib/chart-labels";

interface Vertex {
  x: number;
  y: number;
  /** The allowance line's y at this bucket, or null without one. */
  limitY: number | null;
}

const at = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;

/** One segment per run of two or more buckets; a lone bucket is a dot. */
function linePath(runs: readonly Vertex[][]): string {
  return runs
    .filter((run) => run.length > 1)
    .map((run) =>
      run.map((v, i) => `${i ? "L" : "M"}${at(v.x, v.y)}`).join(" ")
    )
    .join(" ");
}

/** The allowance as a step line, broken wherever the run or the limit is. */
function limitPath(runs: readonly Vertex[][]): string {
  let d = "";
  for (const run of runs) {
    let open = false;
    for (const v of run) {
      if (v.limitY === null) {
        open = false;
        continue;
      }
      d += open
        ? `H${v.x.toFixed(2)} V${v.limitY.toFixed(2)} `
        : `M${at(v.x, v.limitY)} `;
      open = true;
    }
  }
  return d;
}

/** Hollow dots: each lone bucket, and each line end that meets a gap. */
function edgeDots(runs: readonly Vertex[][]): Vertex[] {
  return runs.flatMap((run, k) => {
    const first = run[0];
    const last = run.at(-1);
    if (!first || !last) return [];
    if (run.length === 1) return [first];
    return [...(k > 0 ? [first] : []), ...(k < runs.length - 1 ? [last] : [])];
  });
}

/** Draw true timestamp positions; uncovered buckets break the path. */
export const ContainerHistory = memo(function ContainerHistory({
  page,
  metric,
  title,
  from,
  to,
  events = [],
  compact = false,
  aggregate = false,
}: {
  page: DockerHistoryPage | undefined;
  metric: keyof DockerMetrics;
  title: string;
  from: number;
  to: number;
  events?: readonly DockerEvent[] | undefined;
  compact?: boolean;
  aggregate?: boolean;
}) {
  const height = compact ? 80 : 128;
  const memory = metric.includes("bytes");
  const format = memory
    ? (value: number) =>
        formatBytes(value, value > 0 && value < 1 ? { decimals: 1 } : {})
    : metric === "cpu_pct"
      ? (value: number) => formatPercent(value, { significantDigits: 3 })
      : (value: number) =>
          formatRate(value, value > 0 && value < 1 ? { decimals: 1 } : {});
  const chart = useMemo(() => {
    // Only buckets the line draws: measured and covered (Rust's flag).
    const drawn = (page?.points ?? []).map((p) => {
      const value = p.metrics[metric];
      if (value === null || !(memory ? p.memory_covered : p.cpu_covered))
        return null;
      const allowance = aggregate
        ? p.engine_capacity_bytes
        : p.explicit_limit_bytes;
      return { p, value, allowance: memory ? allowance : null };
    });
    const measured = drawn.filter((d) => d !== null);
    // Fit the range like the comparison chart (design-system.md "Y scale"),
    // including the memory allowance line.
    const ceiling = fittedCeiling(
      Math.max(
        0,
        ...measured.map((d) => d.value),
        ...measured.map((d) => d.allowance ?? 0)
      ),
      memory ? 1024 * 1024 : metric === "cpu_pct" ? 0.1 : 1
    );
    const x = (t: number) => ((t - from) / Math.max(1, to - from)) * 1000;
    // A run breaks at a missing or uncovered bucket and where buckets don't touch.
    const runs = splitRuns(
      drawn,
      (d) => d !== null,
      (a, b) => b.p.time_ms <= a.p.time_ms + a.p.duration_ms
    ).map((run) =>
      run.items.map((d) => ({
        x: x(d.p.time_ms),
        y: chartY(d.value, ceiling, height),
        limitY:
          d.allowance === null ? null : chartY(d.allowance, ceiling, height),
      }))
    );
    const path = linePath(runs);
    const limit = limitPath(runs);
    const dots = edgeDots(runs);
    return { path, limit, dots, ceiling };
  }, [page, metric, memory, from, to, aggregate, height]);
  const ink = memory
    ? "var(--color-mem-ink, var(--color-mem))"
    : "var(--color-cpu-ink, var(--color-cpu))";
  const axis = ceilingAxis(chart.ceiling, format, { zero: true });
  return (
    <SectionCard accent={memory ? "mem" : "cpu"} title={title}>
      {page?.points.length ? (
        <>
          <ChartFrame
            height={height}
            ceiling={chart.ceiling}
            gutter={48}
            yTicks={axis.yTicks}
            xTicks={historyTicks(from, to, false, 3)}
          >
            <svg
              role="img"
              aria-label={`${title}, gaps are unmeasured intervals`}
              viewBox={`0 0 1000 ${height}`}
              height={height}
              className="block w-full overflow-hidden"
              preserveAspectRatio="none"
            >
              <ChartGrid
                values={axis.gridlines}
                ceiling={chart.ceiling}
                height={height}
              />
              <path
                data-line
                d={chart.path}
                fill="none"
                stroke={ink}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
              {chart.limit && (
                <path
                  d={chart.limit}
                  fill="none"
                  stroke="var(--color-muted-foreground)"
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {events.map((event) => (
                <line
                  key={event.id}
                  x1={((event.time_ms - from) / (to - from)) * 1000}
                  x2={((event.time_ms - from) / (to - from)) * 1000}
                  y1={height - 12}
                  y2={height - 1}
                  stroke="var(--color-muted-foreground)"
                  vectorEffect="non-scaling-stroke"
                >
                  <title>
                    {event.action} · {formatDateTime(event.time_ms)}
                  </title>
                </line>
              ))}
            </svg>
            {chart.dots.map((dot) => (
              <GapEdgeDot
                key={dot.x}
                left={cssPercent(dot.x / 1000)}
                top={dot.y}
                color={ink}
              />
            ))}
          </ChartFrame>
          {memory && (
            <p className="text-[11px] text-muted-foreground">
              Working set · dashed line:{" "}
              {aggregate ? "engine capacity" : "explicit memory limit"} at that
              time
            </p>
          )}
        </>
      ) : (
        <p className="py-6 text-[12px] text-muted-foreground">
          {page
            ? "No recorded measurements in this range. Monitoring may have been off or history expired."
            : "Loading recorded measurements…"}
        </p>
      )}
    </SectionCard>
  );
});
