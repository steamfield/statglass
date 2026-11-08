import type { OverviewSettings } from "@core/generated/bindings";
import type { UiModule } from "@core/module-state";
import type { ReactNode } from "react";
import { UnavailableCard } from "~/components/unavailable-card";
import { useEdition } from "~/hooks/use-edition";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { useModuleStates } from "~/hooks/use-module-states";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { useSettings } from "~/stores/settings-store";
import type { Corner } from "~/widgets/lib/accent";
import { OverviewAppsCard } from "../_components/apps-card";
import { OverviewContainersCard } from "../_components/containers-card";
import { OverviewEventsCard } from "../_components/events-card";
import { OverviewFoldersCard } from "../_components/folders-card";
import { OverviewHostsCard } from "../_components/hosts-card";
import {
  OverviewBatteryCard,
  OverviewCpuCard,
  OverviewDiskCard,
  OverviewGpuCard,
  OverviewMemoryCard,
  OverviewNetworkCard,
  OverviewPowerCard,
} from "../_components/overview-cards";

export type OverviewCardId = keyof OverviewSettings;

export interface OverviewItem {
  id: OverviewCardId;
  label: string;
  render: (origin: Corner, windowMs: number) => ReactNode;
}

type CardProps = { origin: Corner; windowMs: number };

/** The module cards in display order; the other cards follow. */
const MODULES: readonly (readonly [
  UiModule & OverviewCardId,
  string,
  (p: CardProps) => ReactNode,
])[] = [
  ["cpu", "CPU", OverviewCpuCard],
  ["gpu", "GPU", OverviewGpuCard],
  ["memory", "Memory", OverviewMemoryCard],
  ["power", "Power & Sensors", OverviewPowerCard],
  ["network", "Network", OverviewNetworkCard],
  ["disk", "Disk", OverviewDiskCard],
  ["battery", "Battery", OverviewBatteryCard],
];

/**
 * The cards this host can fill, in display order, whether or not the user
 * shows them (D-131): a card per module the host has and the user has on
 * (a module the build can't run keeps a "not available" card), Events and
 * Apps, then Largest folders and Containers on This Mac when Space reports
 * and Docker monitoring are on, and Other hosts once a remote host is saved.
 */
export function useOverviewCards(): OverviewItem[] {
  const states = useModuleStates();
  const local = useIsLocalHost();
  const space = useEdition()?.disk_space === true;
  const docker = useSettings((settings) => settings.docker?.enabled === true);
  const remotes = useRemoteHosts((hosts) => hosts.length).data ?? 0;
  const items: OverviewItem[] = [];
  for (const [id, label, Card] of MODULES) {
    const state = states[id];
    if (state === "on")
      items.push({
        id,
        label,
        render: (origin, windowMs) => (
          <Card origin={origin} windowMs={windowMs} />
        ),
      });
    else if (state === "edition" || state === "unavailable")
      items.push({
        id,
        label,
        render: () => <UnavailableCard module={id} state={state} />,
      });
  }
  items.push(
    {
      id: "events",
      label: "Events",
      render: (origin, windowMs) => (
        <OverviewEventsCard origin={origin} windowMs={windowMs} />
      ),
    },
    {
      id: "apps",
      label: "Apps",
      render: (origin, windowMs) => (
        <OverviewAppsCard origin={origin} windowMs={windowMs} />
      ),
    }
  );
  if (local && space)
    items.push({
      id: "folders",
      label: "Largest folders",
      render: (origin) => <OverviewFoldersCard origin={origin} />,
    });
  if (local && docker)
    items.push({
      id: "containers",
      label: "Containers",
      render: (origin, windowMs) => (
        <OverviewContainersCard origin={origin} windowMs={windowMs} />
      ),
    });
  if (remotes > 0)
    items.push({
      id: "hosts",
      label: "Other hosts",
      render: (origin) => <OverviewHostsCard origin={origin} />,
    });
  return items;
}
