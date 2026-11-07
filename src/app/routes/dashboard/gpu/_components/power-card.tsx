import { formatWatts } from "@core/format";
import {
  ModuleHistoryChart,
  type ModuleYAxis,
} from "~/components/charts/module-history-chart";
import { SectionCard } from "~/components/section-card";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";

const KEY = "power.gpu";
const KEYS = [KEY];
/** The card shares a row with the frequency card, down to about 320 px wide. */
const NARROW_TICKS = 3;
const WATTS_AXIS: ModuleYAxis = {
  ceiling: "auto",
  format: (w) => `${w}W`,
};

/**
 * GPU power over the chart window (D-091) on an autoscaled ceiling.
 */
export function PowerCard({ windowMs }: { windowMs: number }) {
  const now = useHeld([KEY])[KEY] ?? null;
  const chart = useModuleChart(KEYS, windowMs, "gpu", { ticks: NARROW_TICKS });

  return (
    <SectionCard
      accent="gpu"
      origin="tr"
      title={`Power, ${chart.span}`}
      aside={<span className="figures text-[13px]">{formatWatts(now)}</span>}
      headerAlign="baseline"
      compactHeader
      headerWrap={false}
      className="gap-3"
    >
      <ModuleHistoryChart
        chart={chart}
        lines={[{ key: KEY, values: chart.series.values[KEY] ?? [], step: 1 }]}
        yAxis={WATTS_AXIS}
        accent="gpu"
        height={140}
        subject="GPU power"
        now={`now ${formatWatts(now)}`}
      />
    </SectionCard>
  );
}
