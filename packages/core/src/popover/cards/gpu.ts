import { formatGhz, formatPercent, formatWatts } from "@core/format";
import type { GpuSelection } from "@core/live-selectors";
import { describeStats } from "@core/widget-models/stat-list";
import type { CardContent, CardSource } from "./types";

export function gpuCard(
  sel: GpuSelection,
  src: CardSource
): CardContent & { headline: string } {
  const items = [
    { label: "Freq", value: formatGhz(sel.freqHz) },
    { label: "Power", value: formatWatts(sel.powerW) },
    { label: "Render", value: formatPercent(sel.render) },
  ];
  return {
    title: "GPU",
    headline: formatPercent(sel.util),
    segments: [],
    items,
    bars: [],
    spoken: describeStats(items, src.chartLabel),
  };
}
