import { formatPercent } from "@core/format";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { InlineMessage } from "~/components/inline-message";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";
import { useModuleRange } from "~/stores/chart-range";

const KEY = "battery.charge";
const KEYS = [KEY];

/**
 * Recorded charge only: averaged charging booleans cannot identify charging
 * intervals. Renders inside the card's own `ChartRangeProvider`, and waits
 * for its range like the module pages do.
 */
export function BatteryRangeHistory() {
  const range = useModuleRange();
  return range ? <ChargeHistory windowMs={range.windowMs} /> : null;
}

function ChargeHistory({ windowMs }: { windowMs: number }) {
  const chart = useModuleChart(KEYS, windowMs, "battery");
  const charge = useHeld(KEYS)[KEY] ?? null;
  return (
    <>
      <ModuleHistoryChart
        chart={chart}
        lines={[{ key: KEY, values: chart.series.values[KEY] ?? [], step: 1 }]}
        yAxis="percent"
        accent="battery"
        height={140}
        ariaLabel={`Battery charge, ${chart.span}, now ${formatPercent(charge)}.`}
      />
      <InlineMessage tone="note">
        Recorded charge. Charging intervals are not inferred from averaged
        samples.
      </InlineMessage>
    </>
  );
}
