import type { TimeRange } from "@core/brush";
import { formatRate } from "@core/format";
import type { DiskIoPage } from "@core/generated/bindings";
import { gapBands } from "@core/history-state";
import { spanWords } from "@core/live-window";
import { DAY_MS, floorTo } from "@core/time-grid";
import { useMemo } from "react";
import type { MirrorChartProps } from "./charts/mirror-chart";

/**
 * Read/write chart props from backend Disk I/O buckets, right-aligned to the
 * requested range with explicit gaps. A null fixed end follows live time;
 * callers own the query resolution and interaction/geometry overrides.
 */
export function useDiskIoReadWriteChart(
  page: DiskIoPage,
  range: TimeRange,
  fixedEndMs: number | null
) {
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
  const gaps = useMemo(
    () => gapBands(page.gaps, first, range.toMs, { module: "disk" }),
    [page.gaps, first, range.toMs]
  );
  const chart: MirrorChartProps = {
    up: points.map((p) => p?.read_bps ?? null),
    down: points.map((p) => p?.write_bps ?? null),
    firstMs: first,
    bucketMs: page.bucket_ms,
    windowMs,
    fixedEndMs,
    subject: "Disk I/O",
    upLabel: "Read",
    downLabel: "Write",
    span: spanWords(windowMs, fixedEndMs),
    format: formatRate,
    minCeiling: 1e6,
    accent: "disk",
    upHeight: 48,
    downHeight: 48,
    gaps,
    brush: false,
    dateLabels: dates,
  };
  return { points, first, count, windowMs, dates, gaps, chart };
}
