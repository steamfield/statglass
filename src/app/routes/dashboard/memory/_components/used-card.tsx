import { formatBytes } from "@core/format";
import { brushScopeProps } from "~/components/brush-overlay";
import { memoryUsedHero } from "~/components/charts/module-hero";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
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
  totalBytes,
}: {
  windowMs: number;
  /** `HostInfo.mem_total_bytes`: the chart's ceiling. */
  totalBytes: number;
}) {
  const units = useUnits();
  const fmt = (x: number | null | undefined) =>
    formatBytes(x, { units: units.bytes });
  const spec = memoryUsedHero(totalBytes, fmt);
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
          now={`of ${fmt(totalBytes)}, used ${fmt(v["mem.used"])}, cached ${fmt(v["mem.cached"])}`}
        />
      </SectionCard>
    </div>
  );
}
