import { formatGhz, formatPercent, formatWatts } from "@core/format";
import { brushScopeProps } from "~/components/brush-overlay";
import { GPU_HERO } from "~/components/charts/module-hero";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { RangeTotalsStrip } from "~/components/range-totals-strip";
import { SectionCard } from "~/components/section-card";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";
import { StatList } from "~/widgets/stat-list";

const HELD = ["gpu.util", "gpu.render", "gpu.tiler", "gpu.freq", "power.gpu"];
const HEIGHT = 200;

/**
 * Utilization strip over the utilization chart, the GPU page's lead card,
 * over the chart window (D-091). Brushable (D-099): the average and peak
 * beside the live strip, and the apps table, follow the selection.
 */
export function UsageCard({ windowMs }: { windowMs: number }) {
  const v = useHeld(HELD);
  const chart = useModuleChart(GPU_HERO.keys, windowMs, GPU_HERO.module, {
    brush: true,
  });
  const util = v["gpu.util"] ?? null;

  return (
    <div {...brushScopeProps} className="contents">
      <SectionCard accent="gpu" title="GPU utilization" hiddenTitle>
        <div className="flex flex-wrap items-end justify-between gap-x-7 gap-y-3">
          <StatList
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
            totals={GPU_HERO.totals}
            testId="gpu-range-totals"
          />
        </div>
        <ModuleHistoryChart
          chart={chart}
          lines={GPU_HERO.lines(chart.series.values)}
          yAxis={GPU_HERO.yAxis}
          accent="gpu"
          height={HEIGHT}
          subject={GPU_HERO.subject}
          now={`now ${formatPercent(util)}`}
        />
      </SectionCard>
    </div>
  );
}
