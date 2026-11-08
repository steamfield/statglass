import type { TimeRange } from "@core/brush";
import { indexAt } from "@core/chart-math";
import {
  formatHistoryTime,
  formatRate,
  MISSING,
  resolutionLabel,
} from "@core/format";
import type { DiskIoPage, DiskIoPoint } from "@core/generated/bindings";
import type { gapBands } from "@core/history-state";
import { spanWords } from "@core/live-window";
import { useCallback, useLayoutEffect, useRef } from "react";
import {
  ChartTooltipHead,
  ChartTooltipRow,
  ChartTooltipRows,
  ChartTooltipShell,
  fillTooltip,
  tooltipBeside,
} from "~/components/charts/chart-tooltip";
import { PLOT_INSET } from "~/components/charts/layout";
import {
  MirrorChart,
  paintMirrorCrosshairs,
} from "~/components/charts/mirror-chart";
import { useDiskIoReadWriteChart } from "~/components/disk-io-chart";
import { SegmentedControl } from "~/components/segmented-control";

export type IoSecondary = "time" | "ops";
const OPTIONS = [
  { value: "time", label: "Average request time" },
  { value: "ops", label: "Operations/s" },
] as const;
export const requestTime = (ms: number | null, ops: number | null) =>
  ms === null
    ? ops === 0
      ? `${MISSING} · No completed operations`
      : `${MISSING} · Unavailable`
    : milliseconds(ms);
const operations = (n: number) =>
  `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} ops/s`;
const milliseconds = (n: number) =>
  n > 0 && n < 0.01
    ? "<0.01 ms"
    : `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ms`;

/** The readout's width, px: `tooltipBeside` places and sizes it. */
const TOOLTIP_WIDTH = 256;
const opsText = (n: number | null | undefined) =>
  n == null ? MISSING : operations(n);
const TOOLTIP_ROWS = [
  ["Read", "read"],
  ["Write", "write"],
  ["Read operations", "readOps"],
  ["Write operations", "writeOps"],
  ["Read request", "readTime"],
  ["Write request", "writeTime"],
] as const;

/** Write one bucket's values into the tooltip's rows. */
function fillPoint(tip: HTMLElement, point: DiskIoPoint | null | undefined) {
  fillTooltip(tip, "read", formatRate(point?.read_bps ?? null));
  fillTooltip(tip, "write", formatRate(point?.write_bps ?? null));
  fillTooltip(tip, "readOps", opsText(point?.read_ops_per_sec));
  fillTooltip(tip, "writeOps", opsText(point?.write_ops_per_sec));
  fillTooltip(
    tip,
    "readTime",
    requestTime(point?.read_request_ms ?? null, point?.read_ops_per_sec ?? null)
  );
  fillTooltip(
    tip,
    "writeTime",
    requestTime(
      point?.write_request_ms ?? null,
      point?.write_ops_per_sec ?? null
    )
  );
}

/** Two views of the same backend buckets, with a shared DOM crosshair. */
export function DiskIoCharts({
  page,
  range,
  fixedEndMs,
  secondary,
  onSecondary,
}: {
  page: DiskIoPage;
  range: TimeRange;
  /** The range's end while it is pinned or selected; null while it follows now. */
  fixedEndMs: number | null;
  secondary: IoSecondary;
  onSecondary: (v: IoSecondary) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const hovered = useRef<number | null>(null);
  const { points, first, count, windowMs, dates, gaps, chart } =
    useDiskIoReadWriteChart(page, range, fixedEndMs);
  const paint = useCallback(
    (time: number | null) => {
      hovered.current = time;
      const root = host.current;
      if (!root) return;
      const bucket = page.bucket_ms;
      const i =
        time === null
          ? null
          : indexAt((time - first) / (count * bucket), count);
      paintMirrorCrosshairs(root, i, count);
      const tip = root.querySelector<HTMLElement>('[role="tooltip"]');
      if (!tip) return;
      tip.hidden = i === null;
      if (i === null) return;
      const at = (k: number) => formatHistoryTime(first + k * bucket, dates);
      Object.assign(
        tip.style,
        tooltipBeside((i + 0.5) / count, TOOLTIP_WIDTH, PLOT_INSET)
      );
      fillTooltip(tip, "title", `${at(i)}–${at(i + 1)}`);
      // The newest bucket of a live range is still filling.
      fillTooltip(
        tip,
        "detail",
        fixedEndMs === null && i === count - 1
          ? "so far"
          : resolutionLabel(bucket)
      );
      fillPoint(tip, points[i]);
    },
    [count, first, page.bucket_ms, points, dates, fixedEndMs]
  );
  useLayoutEffect(() => paint(hovered.current), [paint]);
  const last = points.at(-1);
  const plot = {
    points,
    first,
    bucketMs: page.bucket_ms,
    windowMs,
    fixedEndMs,
    span: spanWords(windowMs, fixedEndMs),
    dates,
    gaps,
    onHover: paint,
  };
  return (
    <div ref={host} className="relative flex flex-col gap-3">
      <MirrorChart {...chart} brush onHoverTime={paint} axis={false} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SegmentedControl
          options={OPTIONS}
          value={secondary}
          onChange={onSecondary}
          ariaLabel="Storage response metric"
        />
        <p
          className="figures text-[11px] text-muted-foreground"
          data-testid="disk-response-current"
        >
          {secondary === "time"
            ? `Read ${requestTime(last?.read_request_ms ?? null, last?.read_ops_per_sec ?? null)} · Write ${requestTime(last?.write_request_ms ?? null, last?.write_ops_per_sec ?? null)}`
            : `Read ${last?.read_ops_per_sec == null ? MISSING : operations(last.read_ops_per_sec)} · Write ${last?.write_ops_per_sec == null ? MISSING : operations(last.write_ops_per_sec)}`}
        </p>
      </div>
      {/* A new series fits its own ceiling: a fixed range never advances
          time, so a held ceiling from the other series would never shrink. */}
      <IoPlot
        key={secondary}
        {...plot}
        subject={secondary === "time" ? "Average request time" : "Operations/s"}
        up={secondary === "time" ? "read_request_ms" : "read_ops_per_sec"}
        down={secondary === "time" ? "write_request_ms" : "write_ops_per_sec"}
        format={secondary === "time" ? milliseconds : operations}
        minimum={secondary === "time" ? 1 : 100}
        axis
      />
      <p className="font-normal text-[11px] text-muted-foreground">
        Completed driver requests, not application response time or queueing
        delay. Chart ceilings adapt to the data, not drive capacity.
      </p>
      <ChartTooltipShell hidden className="top-0 max-w-full">
        <ChartTooltipHead />
        <ChartTooltipRows>
          {TOOLTIP_ROWS.map(([label, field]) => (
            <ChartTooltipRow key={field} label={label} field={field} />
          ))}
        </ChartTooltipRows>
      </ChartTooltipShell>
    </div>
  );
}

/** One mirrored view of the buckets: read above the line, write below. */
function IoPlot({
  points,
  up,
  down,
  first,
  bucketMs,
  windowMs,
  fixedEndMs,
  subject,
  span,
  dates,
  format,
  minimum,
  gaps,
  onHover,
  axis,
}: {
  points: (DiskIoPoint | null)[];
  up: keyof DiskIoPoint;
  down: keyof DiskIoPoint;
  first: number;
  bucketMs: number;
  windowMs: number;
  fixedEndMs: number | null;
  subject: string;
  span: string;
  dates: boolean;
  format: (n: number) => string;
  minimum: number;
  gaps: ReturnType<typeof gapBands>;
  onHover: (t: number | null) => void;
  axis: boolean;
}) {
  return (
    <MirrorChart
      up={points.map((p) => p?.[up] ?? null)}
      down={points.map((p) => p?.[down] ?? null)}
      firstMs={first}
      bucketMs={bucketMs}
      windowMs={windowMs}
      fixedEndMs={fixedEndMs}
      subject={subject}
      upLabel="Read"
      downLabel="Write"
      span={span}
      format={format}
      minCeiling={minimum}
      accent="disk"
      upHeight={48}
      downHeight={48}
      gaps={gaps}
      brush
      onHoverTime={onHover}
      dateLabels={dates}
      axis={axis}
    />
  );
}
