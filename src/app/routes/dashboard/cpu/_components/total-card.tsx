import { fixed, formatPercent, MISSING } from "@core/format";
import { sk } from "@core/series-key";
import { brushScopeProps } from "~/components/brush-overlay";
import { CPU_HERO } from "~/components/charts/module-hero";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { RangeTotalsStrip } from "~/components/range-totals-strip";
import { SectionCard } from "~/components/section-card";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld, useLayout } from "~/hooks/use-ring";
import { DASHBOARD_CHART_HEIGHT } from "~/widgets/chart-frame";
import { StatList, type StatListItem } from "~/widgets/stat-list";

const LOADAVG = ["1", "5", "15"].map((window) => sk("cpu.loadavg", { window }));
const PSI = ["cpu.psi{stall=some}", "cpu.psi{stall=full}"];
const HELD = [
  "cpu.total",
  "cpu.user",
  "cpu.system",
  "cpu.iowait",
  "cpu.steal",
  ...LOADAVG,
  ...PSI,
];
const HEIGHT = DASHBOARD_CHART_HEIGHT;

const load = (v: number | null | undefined) =>
  v == null ? MISSING : fixed(v, 2);

const pct1 = (v: number | null | undefined) =>
  formatPercent(v ?? null, { decimals: 1 });

/**
 * The strip after the hero. I/O wait, steal and pressure stall are Linux
 * series (D-116), shown when the layout carries them. Idle is what neither
 * the total (user + system + steal) nor I/O wait took.
 */
function useStripItems(): { total: number | null; items: StatListItem[] } {
  const v = useHeld(HELD);
  const layout = useLayout();
  const has = (metric: string) => layout?.byMetric.has(metric) ?? false;
  const total = v["cpu.total"] ?? null;
  const iowait = v["cpu.iowait"] ?? null;
  const idle =
    total === null || (has("cpu.iowait") && iowait === null)
      ? null
      : 100 - total - (iowait ?? 0);
  const [l1, l5, l15] = LOADAVG.map((k) => v[k] ?? null);
  const items: StatListItem[] = [
    { label: "User", value: pct1(v["cpu.user"]) },
    { label: "System", value: pct1(v["cpu.system"]), swatch: 2 },
  ];
  if (has("cpu.iowait")) items.push({ label: "I/O wait", value: pct1(iowait) });
  if (has("cpu.steal"))
    items.push({ label: "Steal", value: pct1(v["cpu.steal"]) });
  items.push(
    { label: "Idle", value: pct1(idle), muted: true },
    {
      label: "Load avg",
      value: load(l1),
      secondary: `${load(l5)} ${load(l15)}`,
    }
  );
  if (has("cpu.psi"))
    items.push({
      label: "Pressure stall",
      value: pct1(v["cpu.psi{stall=some}"]),
      secondary: `full ${pct1(v["cpu.psi{stall=full}"])}`,
    });
  return { total, items };
}

/**
 * Stat strip over the total and system area chart (top left), over
 * the chart window (D-091). The chart is brushable (D-099): its average and
 * peak beside the live strip, and the apps table below, follow the selection.
 */
export function TotalCard({ windowMs }: { windowMs: number }) {
  const { total, items } = useStripItems();
  const chart = useModuleChart(CPU_HERO.keys, windowMs, CPU_HERO.module, {
    brush: true,
  });

  return (
    <div {...brushScopeProps} className="contents">
      <SectionCard
        accent="cpu"
        title="CPU total"
        hiddenTitle
        className="col-span-2"
      >
        <div className="flex flex-wrap items-end justify-between gap-x-7 gap-y-3">
          <StatList
            hero={{ label: "Total", value: formatPercent(total) }}
            items={items}
          />
          <RangeTotalsStrip
            windowMs={windowMs}
            totals={CPU_HERO.totals}
            testId="cpu-range-totals"
          />
        </div>
        <ModuleHistoryChart
          chart={chart}
          lines={CPU_HERO.lines(chart.series.values)}
          yAxis={CPU_HERO.yAxis}
          accent="cpu"
          height={HEIGHT}
          subject={CPU_HERO.subject}
          now={`total ${formatPercent(total)}`}
        />
      </SectionCard>
    </div>
  );
}
