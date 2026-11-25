import { ratio } from "@core/chart-math";
import { formatPercent } from "@core/format";
import type { CpuSelection } from "@core/live-selectors";
import { inlineBarModel } from "@core/widget-models/inline-bar";
import { describeStats } from "@core/widget-models/stat-list";
import type { CardContent, CardSource } from "./types";

export function cpuCard(
  sel: CpuSelection,
  src: CardSource
): CardContent & { headline: string } {
  const bars = src.compact
    ? []
    : [
        inlineBarModel({
          label: "User",
          value: formatPercent(sel.user, { decimals: 1 }),
          fraction: ratio(sel.user, 100),
          layout: "row",
        }),
        inlineBarModel({
          label: "System",
          value: formatPercent(sel.system, { decimals: 1 }),
          fraction: ratio(sel.system, 100),
          rampStep: 2,
          layout: "row",
        }),
      ];
  return {
    title: "CPU",
    headline: formatPercent(sel.total),
    segments: [],
    items: [],
    bars,
    spoken: src.compact ? "" : describeStats(bars, src.chartLabel),
  };
}
