import type { TimeRange } from "@core/brush";
import { formatHistoryTime, formatRate, MISSING } from "@core/format";
import type { DiskIoPage, DiskIoPoint } from "@core/generated/bindings";
import { gapBands } from "@core/history-state";
import { spanWords } from "@core/live-window";
import { DAY_MS, floorTo } from "@core/time-grid";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { ChartTooltipShell } from "~/components/charts/chart-tooltip";
import {
  MirrorChart,
  paintMirrorCrosshairs,
} from "~/components/charts/mirror-chart";
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
  const first = floorTo(range.fromMs, page.bucket_ms);
  const count = Math.max(1, Math.ceil((range.toMs - first) / page.bucket_ms));
  const windowMs = range.toMs - range.fromMs;
  const dates = windowMs >= DAY_MS;
  const points = useMemo(() => {
    const byTime = new Map(page.points.map((p) => [p.t, p]));
    return Array.from(
      { length: count },
      (_, i) => byTime.get(first + i * page.bucket_ms) ?? null
    );
  }, [page.points, page.bucket_ms, count, first]);
  const paint = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive logic; split when substantially changed (architecture refactor section 10).
    (time: number | null) => {
      hovered.current = time;
      const root = host.current;
      if (!root) return;
      const i =
        time === null ? -1 : Math.floor((time - first) / page.bucket_ms);
      const point = points[i];
      const valid = i >= 0 && i < count;
      paintMirrorCrosshairs(root, valid ? i : null, count);
      const tip = root.querySelector<HTMLElement>('[role="tooltip"]');
      if (!tip) return;
      tip.hidden = !valid;
      const set = (field: string, value: string) => {
        const el = tip.querySelector(`[data-io-field="${field}"]`);
        if (el) el.textContent = value;
      };
      set(
        "time",
        valid
          ? `${formatHistoryTime(first + i * page.bucket_ms, dates)}–${formatHistoryTime(first + (i + 1) * page.bucket_ms, dates)}`
          : ""
      );
      set("read", formatRate(point?.read_bps ?? null));
      set("write", formatRate(point?.write_bps ?? null));
      set(
        "readOps",
        point?.read_ops_per_sec == null
          ? MISSING
          : operations(point.read_ops_per_sec)
      );
      set(
        "writeOps",
        point?.write_ops_per_sec == null
          ? MISSING
          : operations(point.write_ops_per_sec)
      );
      set(
        "readTime",
        requestTime(
          point?.read_request_ms ?? null,
          point?.read_ops_per_sec ?? null
        )
      );
      set(
        "writeTime",
        requestTime(
          point?.write_request_ms ?? null,
          point?.write_ops_per_sec ?? null
        )
      );
    },
    [count, first, page.bucket_ms, points, dates]
  );
  useLayoutEffect(() => paint(hovered.current), [paint]);
  const gap = useMemo(
    () => gapBands(page.gaps, first, range.toMs, { module: "disk" }),
    [page.gaps, first, range.toMs]
  );
  const last = points.at(-1);
  const plot = {
    points,
    first,
    bucketMs: page.bucket_ms,
    windowMs,
    fixedEndMs,
    span: spanWords(windowMs, fixedEndMs),
    dates,
    gaps: gap,
    onHover: paint,
  };
  return (
    <div ref={host} className="relative flex flex-col gap-3">
      <IoPlot
        {...plot}
        subject="Disk I/O"
        up="read_bps"
        down="write_bps"
        format={formatRate}
        minimum={1e6}
        axis={false}
      />
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
      <IoPlot
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
      <ChartTooltipShell hidden className="top-0 right-0 w-64 max-w-full">
        <span data-io-field="time" className="figures text-[12px]" />
        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[12px]">
          <span>Read</span>
          <span data-io-field="read" className="figures" />
          <span>Write</span>
          <span data-io-field="write" className="figures" />
          <span>Read operations</span>
          <span data-io-field="readOps" className="figures" />
          <span>Write operations</span>
          <span data-io-field="writeOps" className="figures" />
          <span>Read request</span>
          <span data-io-field="readTime" className="figures" />
          <span>Write request</span>
          <span data-io-field="writeTime" className="figures" />
        </div>
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
