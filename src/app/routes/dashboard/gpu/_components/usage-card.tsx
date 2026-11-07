import { formatGhz, formatPercent, formatWatts } from "@core/format";
import { brushScopeProps } from "~/components/brush-overlay";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import {
  type RangeTotal,
  RangeTotalsStrip,
} from "~/components/range-totals-strip";
import { SectionCard } from "~/components/section-card";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";
import { StatStrip } from "~/widgets/stat-strip";

const HELD = ["gpu.util", "gpu.render", "gpu.tiler", "gpu.freq", "power.gpu"];
const CHART = ["gpu.util"];
const HEIGHT = 200;
/** Over the window or the selection (D-099): `gpu.util` averaged and its peak. */
const TOTALS: readonly RangeTotal[] = [
  {
    metric: "gpu.util",
    label: "Avg",
    format: (s) => formatPercent(s.avg, { decimals: 1 }),
  },
  { metric: "gpu.util", label: "Peak", format: (s) => formatPercent(s.max) },
];

/**
 * Utilization strip over the utilization chart, the GPU page's lead card,
 * over the chart window (D-091). Brushable (D-099): the average and peak
 * beside the live strip, and the apps table, follow the selection.
 */
export function UsageCard({ windowMs }: { windowMs: number }) {
  const v = useHeld(HELD);
  const chart = useModuleChart(CHART, windowMs, "gpu", { brush: true });
  const util = v["gpu.util"] ?? null;

  return (
    <div {...brushScopeProps} className="contents">
      <SectionCard accent="gpu" title="GPU utilization" hiddenTitle>
        <div className="flex flex-wrap items-end justify-between gap-x-7 gap-y-3">
          <StatStrip
            hero={{ label: "Utilization", value: formatPercent(util) }}
            items={[
              { label: "Renderer", value: formatPercent(v["gpu.render"]) },
              { label: "Tiler", value: formatPercent(v["gpu.tiler"]) },
              {
                label: "Frequency",
                value: formatGhz(v["gpu.freq"], { decimals: 2 }),
              },
              { label: "Power", value: formatWatts(v["power.gpu"]) },
            ]}
          />
          <RangeTotalsStrip
            windowMs={windowMs}
            totals={TOTALS}
            testId="gpu-range-totals"
          />
        </div>
        <ModuleHistoryChart
          chart={chart}
          lines={[
            {
              key: "gpu.util",
              values: chart.series.values["gpu.util"] ?? [],
              step: 1,
            },
          ]}
          yAxis="percent"
          accent="gpu"
          height={HEIGHT}
          ariaLabel={`GPU utilization, ${chart.span}, now ${formatPercent(util)}.`}
        />
      </SectionCard>
    </div>
  );
}
