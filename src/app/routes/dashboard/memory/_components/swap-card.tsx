import { fixed, formatBytes, MISSING } from "@core/format";
import { brushScopeProps } from "~/components/brush-overlay";
import {
  BYTES_GUTTER,
  ModuleHistoryChart,
} from "~/components/charts/module-history-chart";
import { SectionCard } from "~/components/section-card";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";
import { useUnits } from "~/hooks/use-units";
import { StatList } from "~/widgets/stat-list";

const KEY = "mem.swap_used";
const KEYS = [KEY];
const HEIGHT = 110;

const pages = (v: number | null | undefined) =>
  v == null ? MISSING : `${fixed(v, 0)}`;

/**
 * Swap used over the chart window (D-091) from the ring, with swap-in and
 * swap-out rates. Brushable like the pressure chart (D-099).
 */
export function SwapCard({ windowMs }: { windowMs: number }) {
  const units = useUnits();
  const v = useHeld([KEY, "mem.swap_in", "mem.swap_out"]);
  const chart = useModuleChart(KEYS, windowMs, "memory", { brush: true });
  const fmt = (x: number | null | undefined) =>
    formatBytes(x, { units: units.bytes });

  return (
    <div {...brushScopeProps} className="contents">
      <SectionCard
        accent="mem"
        origin="br"
        variant="default"
        title={`Swap, ${chart.span}`}
        compactHeader
        className="gap-3"
      >
        <StatList
          items={[
            { label: "Used", value: fmt(v[KEY]) },
            { label: "In", value: pages(v["mem.swap_in"]), unit: "pages/s" },
            { label: "Out", value: pages(v["mem.swap_out"]), unit: "pages/s" },
          ]}
        />
        <ModuleHistoryChart
          chart={chart}
          lines={[
            { key: KEY, values: chart.series.values[KEY] ?? [], step: 1 },
          ]}
          yAxis={{
            ceiling: "auto",
            min: 100e6,
            format: fmt,
            gutter: BYTES_GUTTER,
          }}
          accent="mem"
          height={HEIGHT}
          subject="Swap used"
          now={`now ${fmt(v[KEY])}`}
        />
      </SectionCard>
    </div>
  );
}
