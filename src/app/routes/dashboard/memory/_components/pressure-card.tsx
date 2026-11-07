import { formatPercent } from "@core/format";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { brushScopeProps } from "~/components/brush-overlay";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { SectionCard } from "~/components/section-card";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useHeld } from "~/hooks/use-ring";
import { Swap } from "~/lib/motion/swap";
import { cn } from "~/lib/utils";
import { pressureState } from "../_lib/pressure";

const HEIGHT = 160;
const KEY = "mem.pressure";
const KEYS = [KEY];

/**
 * Memory pressure over the chart window (D-091). The state word comes from
 * `mem.pressure_level`; warn and critical carry an icon so they never rely on
 * colour (design-system.md "Status colors"). Brushable (D-099): a range
 * scopes the peaks and the apps table. A Linux host has no macOS pressure;
 * its page shows `UsedCard` here instead.
 */
export function PressureCard({ windowMs }: { windowMs: number }) {
  const v = useHeld([...KEYS, "mem.pressure_level"]);
  const chart = useModuleChart(KEYS, windowMs, "memory", { brush: true });
  const pressure = v[KEY] ?? null;
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
                  "inline-flex items-center gap-1 text-[12px]",
                  state === "warn" ? "text-warning" : "text-destructive"
                )}
              >
                {state === "warn" ? (
                  <TriangleAlert
                    aria-hidden
                    className="size-3.5"
                    strokeWidth={1.75}
                  />
                ) : (
                  <OctagonAlert
                    aria-hidden
                    className="size-3.5"
                    strokeWidth={1.75}
                  />
                )}
                Pressure: {state}
              </Swap>
            )}
            <span className="figures text-[13px]">
              {formatPercent(pressure)}
              {state && (
                <span className="text-[11px] text-muted-foreground">
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
          lines={[
            { key: KEY, values: chart.series.values[KEY] ?? [], step: 1 },
          ]}
          yAxis="percent"
          accent="mem"
          height={HEIGHT}
          ariaLabel={`Memory pressure, ${chart.span}, now ${formatPercent(pressure)}.`}
        />
      </SectionCard>
    </div>
  );
}
