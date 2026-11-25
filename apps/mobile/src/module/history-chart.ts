import { fittedCeiling } from "@core/chart-math";
import { eventLabel } from "@core/events";
import type { Event } from "@core/generated/types";
import { gapBands } from "@core/history-state";
import type { PopoverCard } from "@core/popover/card-order";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import {
  HISTORY_MODULES,
  type HistoryRange,
  type useModuleHistory,
} from "@/data/history";

type PlotHistory = Pick<
  ReturnType<typeof useModuleHistory>,
  "data" | "grid" | "isPending"
>;

/** Return the StreamArea data and the count of real slots the cursor can select. */
export function historyChart(
  module: PopoverCard,
  range: HistoryRange,
  { data, grid, isPending }: PlotHistory,
  events: readonly Event[] | undefined
): { chart: StreamAreaData; sampleCount: number } {
  const {
    title,
    accent,
    series: definitions,
    format,
    ceiling,
  } = HISTORY_MODULES[module];
  const pad = grid !== null && grid.endMs < range.toMs;
  const series = definitions.map(({ key }, index) => {
    const values = grid?.values[key] ?? [];
    return {
      key,
      values: pad ? [...values, null] : values,
      step: index === 0 ? (1 as const) : (2 as const),
    };
  });
  const peak = series.reduce(
    (max, { values }) =>
      values.reduce(
        (current: number, value) => Math.max(current, value ?? 0),
        max
      ),
    0
  );
  const yMax = ceiling ?? fittedCeiling(peak);
  return {
    // The extra slot extends the plot for markers and bands. It has no
    // history bucket and the cursor must never select it.
    sampleCount: (series[0]?.values.length ?? 0) - Number(pad),
    chart: {
      loading: isPending,
      series,
      accent,
      height: 160,
      ariaLabel: `${title} history`,
      tEndMs: grid ? grid.endMs + (pad ? grid.bucketMs : 0) : range.toMs,
      intervalMs: grid?.bucketMs ?? 1,
      yMax,
      ceilingLabel: format(yMax),
      gridlines: [yMax / 2],
      gaps: data
        ? gapBands(data.gaps, range.fromMs, range.toMs, {
            module,
            style: "duration",
          })
        : [],
      annotations:
        events?.map((event) => ({
          tsMs: event.ts_ms,
          label: eventLabel(event),
        })) ?? [],
    },
  };
}
