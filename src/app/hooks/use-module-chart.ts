import { seriesRange } from "@core/chart-math";
import type { Module } from "@core/generated/bindings";
import type { GapBandSpec } from "@core/history-state";
import { spanWords } from "@core/live-window";
import { useGapBands } from "~/hooks/use-gap-bands";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useModuleSeries } from "~/hooks/use-module-series";
import type { WindowSeries } from "~/hooks/use-window-series";
import { historyTicks } from "~/widgets/lib/chart-labels";

/** Every module history chart has this many x ticks, oldest to "now". */
const X_TICKS = 5;

/** What a module page's history chart draws over, from `useModuleChart`. */
export interface ModuleChart {
  series: WindowSeries;
  gaps: GapBandSpec[];
  /** Whether the chart is brushable (its points line up with 10 s buckets). */
  brush: boolean;
  /** The range follows now; false once its end is fixed. */
  live: boolean;
  /** "last 15 minutes" or "selected dates", for titles and labels. */
  span: string;
  xTicks: string[];
  windowMs: number;
}

/**
 * The series, gap bands, span words and x ticks of one module history chart
 * over the module range (D-091). With `brush` the series is read on the
 * brush's buckets (D-099); the owner wraps the card in `brushScopeProps`.
 */
export function useModuleChart(
  keys: readonly string[],
  windowMs: number,
  module: Module,
  { brush = false }: { brush?: boolean } = {}
): ModuleChart {
  const endMs = useModuleEnd();
  const series = useModuleSeries(keys, windowMs, { brush });
  const gaps = useGapBands(module);
  const live = endMs === null;
  const { fromMs, toMs } = seriesRange(series);
  return {
    series,
    gaps,
    brush,
    live,
    span: spanWords(windowMs, endMs),
    xTicks: historyTicks(fromMs, toMs, live, X_TICKS),
    windowMs,
  };
}
