import { rangeScopeWords } from "@core/brush";
import { USAGE_HISTORY_MAX_RANGE_MS } from "@core/generated/bindings";
import { DAY_MS } from "@core/time-grid";
import { useId, useState } from "react";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import {
  SegmentedControl,
  type SegmentedOption,
} from "~/components/segmented-control";
import { useModuleEnd, useUsageHistorical } from "~/hooks/use-module-end";
import { useHost } from "~/stores/host-store";
import { Card } from "~/widgets/card";
import type { Corner } from "~/widgets/lib/accent";
import { ProcessList } from "~/widgets/process-list";
import { type TopAppsMetric, useTopApps } from "../_hooks/use-top-apps";

export function OverviewAppsCard({
  windowMs,
  origin,
}: {
  windowMs: number;
  origin: Corner;
}) {
  const titleId = useId();
  const historical = useUsageHistorical(windowMs);
  const endMs = useModuleEnd();
  const gpu = useHost((s) => s.capabilities?.process_gpu === true);
  const energy = useHost((s) => s.capabilities?.process_energy === true);
  const options = appOptions(gpu, energy, historical);
  const [selected, setSelected] = useState<TopAppsMetric>("cpu");
  // A segment the window no longer offers reads as CPU; the choice comes
  // back when the segment does.
  const by = options.some((option) => option.value === selected)
    ? selected
    : "cpu";
  const apps = useTopApps(windowMs, by);
  const scope = rangeScopeWords(windowMs, endMs);

  return (
    <Card
      accent="cpu"
      origin={origin}
      variant="chart"
      labelledBy={titleId}
      className="flex min-w-0 flex-col gap-3 px-4 py-3.5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 id={titleId} className="font-[590] text-[13px]">
            Apps
          </h3>
        </div>
        <SegmentedControl
          options={options}
          value={by}
          onChange={setSelected}
          ariaLabel="Rank apps by"
        />
      </header>
      <AppsBody apps={apps} historical={historical} scope={scope} />
    </Card>
  );
}

/** The card's list, or the one line that says why there isn't one. */
function AppsBody({
  apps,
  historical,
  scope,
}: {
  apps: ReturnType<typeof useTopApps>;
  historical: boolean;
  scope: string;
}) {
  if (apps.beyondHistory)
    return (
      <p role="status" className="text-[12px] text-muted-foreground">
        Recorded app attribution supports intervals up to{" "}
        {USAGE_HISTORY_MAX_RANGE_MS / DAY_MS} days. Choose a shorter range to
        inspect apps.
      </p>
    );
  if (apps.isError)
    return (
      <p role="alert" className="text-[12px] text-muted-foreground">
        {historical
          ? "Couldn't load app history"
          : "Couldn't load app activity"}
      </p>
    );
  if (apps.isPending) return <ChartHistoryStatus loading />;
  if (apps.rows.length === 0)
    return (
      <p role="status" className="text-[12px] text-muted-foreground">
        {(!historical && apps.note) || `No app activity recorded ${scope}`}
      </p>
    );
  return (
    <>
      <p className="text-[11px] text-muted-foreground">{apps.caption}</p>
      <ProcessList
        rows={apps.rows.map((row) => ({
          ...row,
          initial: row.name.slice(0, 1),
        }))}
        ariaLabel={`Top apps by ${apps.caption}`}
      />
      {apps.note && (
        <p className="text-[11px] text-muted-foreground">{apps.note}</p>
      )}
    </>
  );
}

function appOptions(
  gpu: boolean,
  energy: boolean,
  historical: boolean
): SegmentedOption<TopAppsMetric>[] {
  const options: SegmentedOption<TopAppsMetric>[] = [
    { value: "cpu", label: "CPU" },
    { value: "memory", label: "Memory" },
  ];
  if (gpu) options.push({ value: "gpu", label: "GPU" });
  if (energy)
    options.push({
      value: "energy",
      label: historical ? "CPU power" : "Energy",
    });
  return options;
}
