import { isUnknownChip, type UiModule } from "@core/module-state";
import type { ProcessView } from "@core/process-interest";
import type { ReactNode } from "react";
import { CardGrid } from "~/components/card-grid";
import { ModulePage } from "~/components/module-page";
import {
  SensorDumpDialog,
  useSensorDumpDialog,
} from "~/components/sensor-dump-dialog";
import { UnavailableCard } from "~/components/unavailable-card";
import { UnsupportedNotice } from "~/components/unsupported-notice";
import { useHostRecord } from "~/hooks/use-host-record";
import { useModuleStates } from "~/hooks/use-module-states";
import {
  useProcessGpu,
  useProcessInterest,
  useProcessNetwork,
} from "~/hooks/use-process-interest";
import { useHost } from "~/stores/host-store";
import { useSampling } from "~/stores/live-selectors";
import type { Corner } from "~/widgets/lib/accent";
import { StatusPill } from "~/widgets/status-pill";
import { samplingStatus } from "../_lib/sampling-status";
import { OverviewAppsCard } from "./_components/apps-card";
import { OverviewEventsCard } from "./_components/events-card";
import { LiveMachineHeader } from "./_components/live-machine-header";
import {
  OverviewBatteryCard,
  OverviewCpuCard,
  OverviewDiskCard,
  OverviewGpuCard,
  OverviewMemoryCard,
  OverviewNetworkCard,
  OverviewPowerCard,
} from "./_components/overview-cards";

/**
 * The cards' top-5 lists rank by CPU, memory, energy impact and disk I/O.
 * Rust sends the union of the top 5 by each, every 5 s (D-066), so the
 * Overview no longer makes the collector read every process each tick.
 */
const OVERVIEW_PROCESS_VIEW: ProcessView = {
  limit: 5,
  sort: ["cpu", "memory", "energy", "disk_total"],
  period_ms: 5000,
};

/**
 * With per-process network (D-081) the Network card's list ranks processes
 * by total rate too, and with per-process GPU time (D-085) the GPU card's by
 * GPU share; the host samples each on the same 5 s process ticks while the
 * Overview is visible. `useProcessInterest` compares views by value.
 */
function overviewView(network: boolean, gpu: boolean): ProcessView {
  return {
    ...OVERVIEW_PROCESS_VIEW,
    sort: [
      ...OVERVIEW_PROCESS_VIEW.sort,
      ...(network ? (["net_total"] as const) : []),
      ...(gpu ? (["gpu"] as const) : []),
    ],
    ...(network ? { network } : {}),
    ...(gpu ? { gpu } : {}),
  };
}

/** The Overview's module cards in display order; Events and Apps follow. */
type OverviewCard = readonly [
  UiModule,
  (p: { origin: Corner; windowMs: number }) => ReactNode,
];
const CARDS: readonly OverviewCard[] = [
  ["cpu", OverviewCpuCard],
  ["gpu", OverviewGpuCard],
  ["memory", OverviewMemoryCard],
  ["power", OverviewPowerCard],
  ["network", OverviewNetworkCard],
  ["disk", OverviewDiskCard],
  ["battery", OverviewBatteryCard],
];

/**
 * Overview (plan 4.5): page header with the live status pill,
 * the machine header, and a card per module the host has and the user has
 * on. A module the build cannot run keeps its slot with a "not available"
 * card; an absent one is left out and the grid reflows. On an unknown chip
 * Power & Sensors is hidden and the notice says why.
 */
export default function OverviewRoute() {
  // Process rows feed the CPU, Memory, Power and Disk cards' top-5 lists,
  // the Network card's when the host can attribute traffic, and the GPU
  // card's when it can attribute GPU time.
  const perProcessNetwork = useProcessNetwork();
  const perProcessGpu = useProcessGpu();
  useProcessInterest(overviewView(perProcessNetwork, perProcessGpu));
  const states = useModuleStates();
  const sampling = useSampling();
  const unknownChip = useHost((s) => isUnknownChip(s.capabilities));
  const host = useHostRecord();
  const dump = useSensorDumpDialog();
  // One grid for the modules, Battery, Events and Apps, so the cards after
  // the modules fill whatever the last module row leaves open at any width.
  const items: {
    id: string;
    render: (origin: Corner, windowMs: number) => ReactNode;
  }[] = [];
  for (const [m, Card] of CARDS) {
    const state = states[m];
    if (state === "on")
      items.push({
        id: m,
        render: (origin, windowMs) => (
          <Card origin={origin} windowMs={windowMs} />
        ),
      });
    else if (state === "edition" || state === "unavailable")
      items.push({
        id: m,
        render: () => <UnavailableCard module={m} state={state} />,
      });
  }
  items.push(
    {
      id: "events",
      render: (origin, windowMs) => (
        <OverviewEventsCard origin={origin} windowMs={windowMs} />
      ),
    },
    {
      id: "apps",
      render: (origin, windowMs) => (
        <OverviewAppsCard origin={origin} windowMs={windowMs} />
      ),
    }
  );

  return (
    <>
      <ModulePage
        title="Overview"
        actions={<StatusPill {...samplingStatus(sampling)} />}
        beforeBody={<LiveMachineHeader />}
        afterBody={
          unknownChip && (
            <UnsupportedNotice
              modelId={host?.info.model ?? "this Mac"}
              onShareDump={dump.show}
            />
          )
        }
      >
        {(windowMs) => (
          <CardGrid items={items} getKey={(item) => item.id}>
            {(item, origin) => item.render(origin, windowMs)}
          </CardGrid>
        )}
      </ModulePage>
      <SensorDumpDialog open={dump.open} onOpenChange={dump.setOpen} />
    </>
  );
}
