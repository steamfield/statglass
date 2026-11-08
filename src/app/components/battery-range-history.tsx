import { formatPercent } from "@core/format";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { InlineMessage } from "~/components/inline-message";
import { BATTERY_HERO } from "~/components/module-hero";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";
import { useModuleRange } from "~/stores/chart-range";

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
  const chart = useModuleChart(
    BATTERY_HERO.keys,
    windowMs,
    BATTERY_HERO.module
  );
  const charge = useHeld(BATTERY_HERO.keys)[BATTERY_HERO.keys[0]] ?? null;
  return (
    <>
      <ModuleHistoryChart
        chart={chart}
        lines={BATTERY_HERO.lines(chart.series.values)}
        yAxis={BATTERY_HERO.yAxis}
        accent="battery"
        height={140}
        subject={BATTERY_HERO.subject}
        now={`now ${formatPercent(charge)}`}
      />
      <InlineMessage tone="note">
        Recorded charge. Charging intervals are not inferred from averaged
        samples.
      </InlineMessage>
    </>
  );
}
