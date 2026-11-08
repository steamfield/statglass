import { formatBytes, MISSING } from "@core/format";
import { brushScopeProps } from "~/components/brush-overlay";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import type { HeroChartSpec } from "~/components/module-hero";
import { SectionCard } from "~/components/section-card";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";
import { useUnits } from "~/hooks/use-units";
import { Legend } from "~/widgets/legend";

const HEIGHT = 160;
/**
 * Used memory with cached files stacked on it over the chart window, up to
 * MemTotal (D-091), on a host that reports Linux's used, cached and free
 * (D-116) in place of macOS pressure. The PSI figures sit in the composition
 * strip. Brushable like the pressure chart (D-099): a range scopes the
 * peaks and the apps table.
 */
export function UsedCard({
  windowMs,
  spec,
  totalLabel,
}: {
  windowMs: number;
  /** Host-selected used-memory chart and MemTotal scale. */
  spec: HeroChartSpec;
  totalLabel: string | null;
}) {
  const units = useUnits();
  const fmt = (x: number | null | undefined) =>
    formatBytes(x, { units: units.bytes });
  const v = useHeld(spec.keys);
  const chart = useModuleChart(spec.keys, windowMs, spec.module, {
    brush: true,
  });

  return (
    <div {...brushScopeProps} className="contents">
      <SectionCard
        accent="mem"
        origin="bl"
        title="Used"
        headerAlign="baseline"
        compactHeader
        headerWrap={false}
        className="gap-3"
        aside={
          <Legend
            items={[
              { label: "Used", value: fmt(v["mem.used"]), step: 1 },
              { label: "Cached files", value: fmt(v["mem.cached"]), step: 4 },
            ]}
          />
        }
      >
        <ModuleHistoryChart
          chart={chart}
          lines={spec.lines(chart.series.values)}
          yAxis={spec.yAxis}
          accent="mem"
          height={HEIGHT}
          subject={spec.subject}
          now={`of ${totalLabel ?? MISSING}, used ${fmt(v["mem.used"])}, cached ${fmt(v["mem.cached"])}`}
        />
      </SectionCard>
    </div>
  );
}
