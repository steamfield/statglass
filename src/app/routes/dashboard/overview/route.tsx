import { isUnknownChip } from "@core/module-state";
import type { ProcessView } from "@core/process-interest";
import { CardGrid } from "~/components/card-grid";
import { ModulePage } from "~/components/module-page";
import {
  SensorDumpDialog,
  useSensorDumpDialog,
} from "~/components/sensor-dump-dialog";
import { UnsupportedNotice } from "~/components/unsupported-notice";
import { useHostRecord } from "~/hooks/use-host-record";
import {
  useProcessGpu,
  useProcessInterest,
  useProcessNetwork,
} from "~/hooks/use-process-interest";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { useHost } from "~/stores/host-store";
import { useSampling } from "~/stores/live-selectors";
import { useSettings } from "~/stores/settings-store";
import { StatusPill } from "~/widgets/status-pill";
import { samplingStatus } from "../_lib/sampling-status";
import { CardsMenu } from "./_components/cards-menu";
import { LiveMachineHeader } from "./_components/live-machine-header";
import { useOverviewCards } from "./_hooks/use-overview-cards";

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
  const sampling = useSampling();
  const unknownChip = useHost((s) => isUnknownChip(s.capabilities));
  const host = useHostRecord();
  const dump = useSensorDumpDialog();
  // One grid for every card, so the cards after the modules fill whatever
  // the last module row leaves open at any width. The user's picks filter
  // the cards this host can fill (D-131).
  const cards = useOverviewCards();
  const saved = useSettings((settings) => settings.overview);
  const write = useWriteSettings();
  const shown = (id: keyof NonNullable<typeof saved>) => saved?.[id] !== false;
  const items = cards.filter((card) => shown(card.id));

  return (
    <>
      <ModulePage
        title="Overview"
        actions={
          <>
            <StatusPill {...samplingStatus(sampling)} />
            <CardsMenu
              items={cards}
              shown={shown}
              onChange={(overview) => write({ overview })}
            />
          </>
        }
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
        {(windowMs) =>
          items.length === 0 ? (
            <p role="status" className="text-[13px] text-muted-foreground">
              Every card is hidden. Pick the cards to show from the Overview
              cards menu.
            </p>
          ) : (
            <CardGrid items={items} getKey={(item) => item.id}>
              {(item, origin) => item.render(origin, windowMs)}
            </CardGrid>
          )
        }
      </ModulePage>
      <SensorDumpDialog open={dump.open} onOpenChange={dump.setOpen} />
    </>
  );
}
