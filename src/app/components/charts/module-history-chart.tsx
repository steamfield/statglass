import type { CeilingLadder } from "@core/chart-math";
import { useAreaBrush } from "~/components/area-brush";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { SelectionSummary } from "~/components/selection-summary";
import { useChartLabel } from "~/hooks/use-chart-label";
import type { ModuleChart } from "~/hooks/use-module-chart";
import { useNiceCeiling } from "~/hooks/use-nice-ceiling";
import type { Accent } from "~/widgets/lib/accent";
import {
  ceilingAxis,
  PERCENT_GRID,
  PERCENT_Y_TICKS,
} from "~/widgets/lib/chart-labels";
import { StreamArea, type StreamAreaProps } from "~/widgets/stream-area";

/** Y tick gutter, px (design-system.md: 32 for live area charts). */
const GUTTER = 32;
/** The wider gutter byte labels ("16.5 GB") need, as on container axes. */
export const BYTES_GUTTER = 48;

/**
 * A module history chart's y axis. `percent` is the fixed 0 to 100% grid.
 * A ceiling is fixed (MemTotal) or `auto`: a nice step over every drawn
 * line, from `min` up, shrinking only after 60 s below the next step down
 * (design-system.md "Y scale"). Its ticks at the ceiling and half of it
 * read through `format`; byte labels need a wider `gutter`, and bytes shown
 * in binary units snap on the `binary` ladder.
 */
export type ModuleYAxis =
  | "percent"
  | {
      ceiling: number | "auto";
      min?: number;
      ladder?: CeilingLadder;
      format: (value: number) => string;
      gutter?: number;
    };

const NO_VALUES: readonly (number | null)[] = [];

function maxOf(values: readonly (number | null)[]): number | null {
  let max: number | null = null;
  for (const v of values) if (v !== null && (max === null || v > max)) max = v;
  return max;
}

/**
 * What an auto ceiling fits: every drawn line, app lines included. Several
 * lines reduce to their maxima, so a 1 Hz render does not copy every point.
 */
function fitted(
  axis: ModuleYAxis,
  lines: StreamAreaProps["series"]
): readonly (number | null)[] {
  if (axis === "percent" || axis.ceiling !== "auto") return NO_VALUES;
  return lines.length === 1
    ? (lines[0]?.values ?? NO_VALUES)
    : lines.map((l) => maxOf(l.values));
}

function useYAxis(
  axis: ModuleYAxis,
  lines: StreamAreaProps["series"],
  chart: ModuleChart
) {
  const auto = useNiceCeiling(
    fitted(axis, lines),
    chart.series.tEndMs,
    axis === "percent" ? 1 : (axis.min ?? 1),
    chart.windowMs,
    {
      endMs: chart.endMs,
      intervalMs: chart.series.intervalMs,
      ladder: axis === "percent" ? "decimal" : (axis.ladder ?? "decimal"),
    }
  );
  if (axis === "percent")
    return { yMax: 100, gridlines: PERCENT_GRID, yTicks: PERCENT_Y_TICKS };
  const yMax = axis.ceiling === "auto" ? auto : axis.ceiling;
  const { gridlines, yTicks } = ceilingAxis(yMax, axis.format);
  return { yMax, gridlines, yTicks, gutter: axis.gutter };
}

/**
 * The history chart of a module page card (C1): the loading line, the area
 * chart with its gutter ticks, gap bands and x ticks, and, when the chart is
 * brushable, the brush and the selection line under it. The card owns the
 * lines it draws, their legend and the accessible name's figures.
 */
export function ModuleHistoryChart({
  chart,
  lines,
  yAxis,
  accent,
  height,
  subject,
  now,
  annotations,
}: {
  chart: ModuleChart;
  lines: StreamAreaProps["series"];
  yAxis: ModuleYAxis;
  accent: Accent;
  height: number;
  /** What it shows over `chart.span` ("GPU power"), for the accessible name. */
  subject: string;
  /** The figures now ("now 3.1 W"); the name holds them for 10 s at a time. */
  now?: string;
  annotations?: StreamAreaProps["annotations"];
}) {
  const { series, gaps } = chart;
  const y = useYAxis(yAxis, lines, chart);
  const brush = useAreaBrush(series, height, chart.brush, gaps);
  const ariaLabel = useChartLabel({
    subject,
    span: chart.span,
    now,
    brushable: chart.brush,
  });
  return (
    <div className="flex flex-col gap-1.5">
      <ChartHistoryStatus loading={series.loading} error={series.error} />
      <StreamArea
        gaps={gaps}
        series={lines}
        tEndMs={series.tEndMs}
        intervalMs={series.intervalMs}
        accent={accent}
        height={height}
        ariaLabel={ariaLabel}
        {...y}
        xTicks={chart.xTicks}
        highlight={brush.highlight}
        overlay={brush.overlay}
        {...(annotations && { annotations })}
      />
      {chart.brush && (
        <SelectionSummary
          windowMs={chart.windowMs}
          inset={y.gutter ?? GUTTER}
        />
      )}
    </div>
  );
}
