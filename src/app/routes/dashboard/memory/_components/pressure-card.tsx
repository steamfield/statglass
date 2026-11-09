import { formatPercent } from "@core/format";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { brushScopeProps } from "~/components/brush-overlay";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { MEMORY_PRESSURE_HERO } from "~/components/module-hero";
import { SectionCard } from "~/components/section-card";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";
import { Swap } from "~/lib/motion/swap";
import { cn } from "~/lib/utils";
import { pressureState } from "../_lib/pressure";

const HEIGHT = 160;

/**
 * Memory pressure over the chart window (D-091). The state word comes from
 * `mem.pressure_level`; warn and critical carry an icon so they never rely on
 * colour (design-system.md "Status colors"). Brushable (D-099): a range
 * scopes the peaks and the apps table. A Linux host has no macOS pressure;
 * its page shows `UsedCard` here instead.
 */
export function PressureCard({ windowMs }: { windowMs: number }) {
  const v = useHeld([...MEMORY_PRESSURE_HERO.keys, "mem.pressure_level"]);
  const chart = useModuleChart(
    MEMORY_PRESSURE_HERO.keys,
    windowMs,
    MEMORY_PRESSURE_HERO.module,
    { brush: true }
  );
  const pressure = v["mem.pressure"] ?? null;
  const state = pressureState(v["mem.pressure_level"] ?? null);

  return (
    <div {...brushScopeProps} className="contents">
      <SectionCard
        accent="mem"
        origin="bl"
        title="Pressure"
        headerAlign="baseline"
        compactHeader
        headerWrap={false}
        className="gap-3"
        aside={
          <span className="flex items-baseline gap-3">
            {(state === "warn" || state === "critical") && (
              <Swap
                k={state}
                className={cn(
                  "inline-flex items-center gap-1 text-small",
                  state === "warn" ? "text-warning" : "text-destructive"
                )}
              >
                {state === "warn" ? (
                  <TriangleAlert
                    aria-hidden
                    className="icon-regular size-3.5"
                  />
                ) : (
                  <OctagonAlert aria-hidden className="icon-regular size-3.5" />
                )}
                Pressure: {state}
              </Swap>
            )}
            <span className="figures text-body">
              {formatPercent(pressure)}
              {state && (
                <span className="text-label text-muted-foreground">
                  {" "}
                  {state}
                </span>
              )}
            </span>
          </span>
        }
      >
        <ModuleHistoryChart
          chart={chart}
          lines={MEMORY_PRESSURE_HERO.lines(chart.series.values)}
          yAxis={MEMORY_PRESSURE_HERO.yAxis}
          accent="mem"
          height={HEIGHT}
          subject={MEMORY_PRESSURE_HERO.subject}
          now={`now ${formatPercent(pressure)}`}
        />
      </SectionCard>
    </div>
  );
}
