import { commandError } from "@core/command-error";
import type { HeatmapMetric } from "@core/generated/bindings";
import { historyUnavailable } from "@core/history-state";
import { failureReason } from "@core/remote-errors";
import { memo, useCallback, useState } from "react";
import { SectionCard } from "~/components/section-card";
import { SegmentedControl } from "~/components/segmented-control";
import { useHostClock } from "~/lib/host-clock";
import { useHeatmap } from "../_hooks/use-heatmap";
import type { LaneUnits } from "../_lib/format";
import {
  cellName,
  HEATMAP_SCALES,
  type HeatmapRow,
  LEGEND_ALPHAS,
  legendEnds,
} from "../_lib/heatmap";
import { heatmapCellView, type Span } from "../_lib/time";
import { CalendarHeatmap } from "./calendar-heatmap";

const METRICS = [
  { value: "cpu", label: "Avg CPU" },
  { value: "temp", label: "Temperature" },
] as const;

const SUBTITLES: Record<HeatmapMetric, string> = {
  cpu: "Average CPU per hour.",
  temp: "Hottest SoC zone, averaged per hour.",
};

const GRID_LABELS: Record<HeatmapMetric, string> = {
  cpu: "Average CPU by hour, last 30 days",
  temp: "Average temperature by hour, last 30 days",
};

/** The store is off or unreadable, which the history banner already says. */
function unavailable(error: Error): boolean {
  const typed = commandError(error);
  return typed !== null && historyUnavailable(typed) !== null;
}

export interface HeatmapCardProps {
  units: LaneUnits;
  /** Opens the Timeline on a cell's hour. */
  onOpen: (view: { span: Span; endMs: number | null }) => void;
}

/**
 * "Last 30 days, by hour": the calendar heatmap with
 * its metric toggle and legend. Reads once an hour and never subscribes to
 * the live frames.
 */
export const HeatmapCard = memo(function HeatmapCard({
  units,
  onOpen,
}: HeatmapCardProps) {
  const clock = useHostClock();
  const [metric, setMetric] = useState<HeatmapMetric>("cpu");
  const { rows, current, hourMs, loading, error } = useHeatmap(metric);
  const scale = HEATMAP_SCALES[metric];
  const [lo, hi] = legendEnds(metric, units);

  const name = useCallback(
    (row: HeatmapRow, hour: number) =>
      cellName(row, hour, metric, units, { nowHourMs: hourMs, loading }),
    [metric, units, hourMs, loading]
  );
  const select = useCallback(
    (row: HeatmapRow, hour: number) =>
      onOpen(
        heatmapCellView(
          row.hourStarts[hour] as number,
          row.hourStarts[hour + 1] as number,
          clock()
        )
      ),
    [onOpen, clock]
  );

  return (
    <SectionCard
      accent={scale.accent}
      origin="br"
      title="Last 30 days, by hour"
      subtitle={
        <>
          {SUBTITLES[metric]} Hatched hours had no samples (asleep or off).
          Click a cell to open that hour.
        </>
      }
      headerAlign="center"
      className="gap-3"
      aside={
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            options={METRICS}
            value={metric}
            onChange={setMetric}
            ariaLabel="Heatmap metric"
          />
          <div aria-hidden className="flex items-center gap-1">
            <span className="figures mr-1 text-[10px] text-muted-foreground">
              {lo}
            </span>
            {LEGEND_ALPHAS.map((a) => (
              <span
                key={a}
                data-legend-swatch
                className="h-2.5 w-3.5 rounded-[2px]"
                style={{
                  background: `color-mix(in srgb, var(--color-${scale.accent}) ${a * 100}%, transparent)`,
                }}
              />
            ))}
            <span className="figures ml-1 text-[10px] text-muted-foreground">
              {hi}
            </span>
          </div>
        </div>
      }
    >
      {error ? (
        <p className="font-normal text-[13px] text-fg-subtle">
          {unavailable(error)
            ? "No history is being kept, so there are no past hours to show."
            : `The heatmap could not be read. ${failureReason(error, "Please try again.")}`}
        </p>
      ) : (
        <CalendarHeatmap
          rows={rows}
          scale={scale}
          current={current}
          nowHourMs={hourMs}
          loading={loading}
          cellName={name}
          onSelect={select}
          ariaLabel={GRID_LABELS[metric]}
        />
      )}
    </SectionCard>
  );
});
