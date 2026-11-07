import { useMemo } from "react";
import {
  ChartTable,
  type ChartTableRow,
  type ChartTableSeries,
  type ChartTableStats,
} from "~/components/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import type { Bucket } from "../_lib/buckets";
import { formatMetric, type LaneUnits } from "../_lib/format";
import type { Band } from "../_lib/gaps";
import type { LaneDef } from "../_lib/lanes";
import { dayClock } from "../_lib/time";

export interface LaneTableDialogProps {
  lane: { def: LaneDef; series: Record<string, Bucket[]> } | null;
  bands: readonly Band[];
  /** The visible range and its bucket width. */
  range: { fromMs: number; toMs: number; bucketMs: number };
  units: LaneUnits;
  onClose: () => void;
}

/** Column group names for lanes that plot two series. */
const SERIES_NAME: Record<string, string> = {
  "power.system": "System",
  "power.cpu": "CPU",
  "net.tx_total": "Up",
  "net.rx_total": "Down",
};

/** Each plotted metric's buckets by start, and a row per gap in the lane. */
function laneRows(
  lane: NonNullable<LaneTableDialogProps["lane"]>,
  metrics: readonly string[],
  bands: readonly Band[]
): ChartTableRow[] {
  const byT = new Map<number, (ChartTableStats | null)[]>();
  metrics.forEach((metric, i) => {
    for (const b of lane.series[metric] ?? []) {
      const values = byT.get(b.t) ?? metrics.map(() => null);
      values[i] = b;
      byT.set(b.t, values);
    }
  });
  const rows: ChartTableRow[] = [...byT].map(([t, values]) => ({
    kind: "bucket",
    t,
    values,
  }));
  for (const band of bands) {
    if (band.module === null || band.module === lane.def.module)
      rows.push({ kind: "gap", t: band.fromMs, label: band.label });
  }
  return rows;
}

/** "Show as table" for one Timeline lane, in a dialog over the lanes. */
export function LaneTableDialog({
  lane,
  bands,
  range: { fromMs, toMs, bucketMs },
  units,
  onClose,
}: LaneTableDialogProps) {
  const metrics = useMemo(
    () => lane?.def.metrics.filter((m) => m.plotted).map((m) => m.metric) ?? [],
    [lane]
  );
  const series = useMemo<ChartTableSeries[]>(
    () =>
      metrics.map((metric) => ({
        id: metric,
        label: SERIES_NAME[metric] ?? metric,
        format: (v) => formatMetric(metric, v, units),
      })),
    [metrics, units]
  );
  const rows = useMemo(
    () => (lane ? laneRows(lane, metrics, bands) : []),
    [lane, metrics, bands]
  );

  return (
    <Dialog open={lane !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          "max-h-[80vh] grid-rows-[auto_minmax(0,1fr)]",
          // Two series need seven columns: room for all of them without scrolling.
          series.length > 1 ? "sm:max-w-2xl" : "sm:max-w-xl"
        )}
      >
        <DialogHeader>
          <DialogTitle>{lane?.def.label} as a table</DialogTitle>
          <DialogDescription>
            <span className="figures">{dayClock(fromMs)}</span> to{" "}
            <span className="figures">{dayClock(toMs)}</span>, one row per
            bucket
          </DialogDescription>
        </DialogHeader>
        <ChartTable
          label={`${lane?.def.label ?? ""} values`}
          series={series}
          rows={rows}
          bucketMs={bucketMs}
          fromMs={fromMs}
          toMs={toMs}
          surface="popover"
          className="min-h-0"
        />
      </DialogContent>
    </Dialog>
  );
}
