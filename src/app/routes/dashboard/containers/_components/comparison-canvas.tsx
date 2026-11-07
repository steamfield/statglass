import { nearestTime } from "@core/chart-math";
import {
  type ComparisonMetric,
  pointValue,
  seriesColor,
} from "@core/chart-math/series-lines";
import type {
  DockerContainer,
  DockerCoverage,
  DockerHistoryPoint,
} from "@core/generated/bindings";
import { useMemo } from "react";
import { useBrushOverlay } from "~/components/area-brush";
import { CrosshairLine } from "~/components/charts/crosshair-line";
import {
  ChartFrame,
  ChartGrid,
  ChartSelectionVeil,
  chartY,
  DASHBOARD_CHART_HEIGHT,
} from "~/widgets/chart-frame";
import { GapBand } from "~/widgets/gap-band";
import { ceilingAxis, historyTicks } from "~/widgets/lib/chart-labels";
import type { ComparisonSeries } from "./comparison-chart";
import { ComparisonLines } from "./comparison-lines";
import type { ComparisonPlotState } from "./comparison-plot-state";
import { ComparisonTooltip } from "./comparison-tooltip";

const HEIGHT = DASHBOARD_CHART_HEIGHT;
export function ComparisonCanvas({
  series,
  metric,
  from,
  to,
  live,
  range,
  metricGaps,
  plot,
  onFocus,
  loading,
  duration,
  clock,
  displayName,
  statistics,
  format,
}: {
  series: readonly ComparisonSeries[];
  metric: ComparisonMetric;
  from: number;
  to: number;
  live: boolean;
  range: string;
  metricGaps: readonly DockerCoverage[];
  plot: ComparisonPlotState;
  onFocus: (id: string | null) => void;
  loading: boolean;
  duration: number;
  clock: (time: number) => string;
  displayName: (container: DockerContainer) => string;
  statistics: (point: DockerHistoryPoint) => string;
  format: (value: number | null) => string;
}) {
  const {
    plotRef,
    plotWidth,
    setHoverTime,
    selection,
    pinned,
    times,
    cursor,
    ceiling,
    active,
    plotSeries,
    rows,
    link,
  } = plot;
  const lines = useMemo(
    () => (
      <ComparisonLines
        plotSeries={plotSeries}
        active={active}
        onFocus={onFocus}
        plotWidth={plotWidth}
      />
    ),
    [plotSeries, active, onFocus, plotWidth]
  );
  const axis = ceilingAxis(ceiling, format, { zero: true });
  const engineGaps = useMemo(
    () =>
      metricGaps
        .filter((gap) => gap.container_id === null)
        .map((gap) => ({
          fromMs: gap.start_ms,
          toMs: gap.end_ms ?? to,
          label: gap.label,
        })),
    [metricGaps, to]
  );
  const brush = useBrushOverlay({
    firstMs: from,
    spanMs: to - from,
    height: HEIGHT,
    inset: 0,
    gaps: engineGaps,
    onHoverTime: (time, fractionY) => {
      const nearest = time === null ? null : nearestTime(times, time);
      if (time === null || nearest === null) {
        setHoverTime(null);
        onFocus(null);
        return;
      }
      setHoverTime(time);
      const line = series
        .map((s) => {
          const point = s.points.find((p) => p.time_ms === nearest);
          const value = point ? pointValue(point, metric) : null;
          return {
            id: s.container.id,
            distance:
              value === null
                ? Infinity
                : Math.abs(chartY(value, ceiling, HEIGHT) - fractionY * HEIGHT),
          };
        })
        .sort((a, b) => a.distance - b.distance)[0];
      onFocus(line && line.distance < 8 ? line.id : null);
    },
  });
  return (
    <ChartFrame
      height={HEIGHT}
      ceiling={ceiling}
      gutter={48}
      plotRef={plotRef}
      yTicks={axis.yTicks}
      xTicks={historyTicks(from, to, live)}
    >
      <div className="pointer-events-none absolute inset-0">
        {metricGaps
          .filter((gap) => gap.container_id === null)
          .map((gap) => (
            <GapBand
              key={`${gap.reason}:${gap.start_ms}`}
              fromMs={gap.start_ms}
              toMs={gap.end_ms ?? to}
              rangeFromMs={from}
              rangeToMs={to}
              label={gap.label}
              labelPosition="none"
            />
          ))}
      </div>
      <svg
        role="img"
        aria-label={`${metric === "cpu" ? "CPU" : "Memory"} by container, ${range}, ${series.map((s) => displayName(s.container)).join(", ") || "no containers"}`}
        viewBox={`0 0 1000 ${HEIGHT}`}
        preserveAspectRatio="none"
        height={HEIGHT}
        className="block w-full overflow-visible rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChartGrid values={axis.gridlines} ceiling={ceiling} height={HEIGHT} />
        {lines}
      </svg>
      {cursor !== null && (
        <CrosshairLine
          left={`${((cursor - from) / (to - from)) * 100}%`}
          dots={rows.flatMap((row) =>
            row.value === null
              ? []
              : [
                  {
                    key: row.container.id,
                    top: chartY(row.value, ceiling, HEIGHT),
                    color: seriesColor(row.slot),
                  },
                ]
          )}
        />
      )}
      <ChartSelectionVeil highlight={brush.highlight} />
      {brush.overlay}
      {!times.length && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">
          {loading
            ? "Loading recorded measurements…"
            : "No recorded measurements in this range."}
        </p>
      )}
      {cursor !== null && (
        <ComparisonTooltip
          rows={rows}
          pinned={pinned}
          selection={selection}
          cursor={cursor}
          from={from}
          to={to}
          duration={duration}
          clock={clock}
          link={link}
          displayName={displayName}
          statistics={statistics}
          format={format}
          metric={metric}
        />
      )}
    </ChartFrame>
  );
}
