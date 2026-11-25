import { ratio } from "@core/chart-math";
import { scaleOrNull, sumOrNull } from "@core/chart-math/numeric";
import { formatPercent, formatWatts } from "@core/format";
import type { UiModule } from "@core/module-state";
import { remoteConnectionView } from "@core/remote-connection";
import { hostsNeedingUpdate } from "@core/remote-hosts";
import { GITHUB_ISSUES_URL } from "@core/star-prompt";
import { MessageSquare } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { HostSwitcher } from "~/components/host-switcher";
import { PerformanceExplainer } from "~/components/performance-explainer";
import { Sidebar, type SidebarEntry } from "~/components/sidebar";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "~/components/ui/hover-card";
import { useSpaceStatus } from "~/hooks/use-disk-space";
import { useEdition } from "~/hooks/use-edition";
import { useHostRecord } from "~/hooks/use-host-record";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { useModuleStates } from "~/hooks/use-module-states";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { openExternalUrl } from "~/lib/github-links";
import { useHostSelection } from "~/lib/host-selection";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";
import {
  useBattery,
  useCgroups,
  useCpu,
  useDisk,
  useGpu,
  useMemory,
  useNetwork,
  usePower,
  useSampling,
} from "~/stores/live-selectors";
import { useSettings } from "~/stores/settings-store";
import { MODULE_META } from "~/widgets/lib/module-meta";
import { version } from "../../../../../package.json";
import { batteryBackoff } from "../_lib/sampling-status";

const NAV_ENTRIES: readonly SidebarEntry[] = [
  {
    id: "overview",
    href: "/dashboard/overview",
    label: "Overview",
    icon: "overview" as const,
  },
  {
    id: "timeline",
    href: "/dashboard/timeline",
    label: "Timeline",
    icon: "timeline" as const,
  },
];
const LOCAL_TOOLS: readonly SidebarEntry[] = [
  {
    id: "hosts",
    href: "/dashboard/hosts",
    label: "Hosts",
    icon: "hosts" as const,
  },
  {
    id: "processes",
    href: "/dashboard/processes",
    label: "Processes",
    icon: "processes" as const,
  },
  {
    id: "containers",
    href: "/dashboard/containers",
    label: "Containers",
    icon: "containers" as const,
  },
  {
    id: "alerts",
    href: "/dashboard/alerts",
    label: "Alerts",
    icon: "alerts" as const,
  },
  {
    id: "settings",
    href: "/dashboard/settings",
    label: "Settings",
    icon: "settings" as const,
  },
];
const SCAN_BUSY = { label: "Scan running" };

const countBehind = (hosts: Parameters<typeof hostsNeedingUpdate>[0]) =>
  hostsNeedingUpdate(hosts).length;

/** Hosts carries a count while any host is behind this Mac (D-123). */
function withHostAttention(
  entries: readonly SidebarEntry[],
  behind: number
): readonly SidebarEntry[] {
  if (behind === 0) return entries;
  const label = `${behind === 1 ? "1 host needs" : `${behind} hosts need`} an update`;
  return entries.map((entry) =>
    entry.id === "hosts"
      ? { ...entry, attention: { count: behind, label } }
      : entry
  );
}

/** MB/s, no space ("38.4M", "220M"). */
export function compactRate(bps: number | null): string | undefined {
  if (bps === null) return undefined;
  const mb = bps / 1e6;
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)}M`;
}

const SidebarFeedbackAction = memo(function SidebarFeedbackAction() {
  const transport = useTransport();
  const onOpenIssues = useCallback(
    () => openExternalUrl(transport, GITHUB_ISSUES_URL, "sidebar"),
    [transport]
  );

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onOpenIssues}
          className="flex h-7 w-full items-center gap-2.5 rounded-control px-2 text-left text-fg-subtle outline-none hover:bg-selected hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageSquare aria-hidden className="icon-light size-4 shrink-0" />
          <span className="truncate text-body max-sm:sr-only">Feedback</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="end" className="w-60">
        <p className="font-semibold text-foreground text-small">Feedback</p>
        <p className="mt-1 font-normal text-label text-muted-foreground">
          Have an issue or want a feature? File feedback on GitHub.
        </p>
      </HoverCardContent>
    </HoverCard>
  );
});

/**
 * Dashboard sidebar with live values (plan 4.4). Modules the host
 * lacks are omitted, and so is Power & Sensors on an unknown chip (4.17).
 * Modules switched off, or that this build cannot run, are dimmed without a
 * value. Network and Disk show the sum of both directions.
 */
export function LiveSidebar() {
  const local = useIsLocalHost();
  const hostId = useHostId();
  // A remote host lists Containers when it reports cgroup groups (D-116).
  const cgroups = useCgroups();
  const navigate = useNavigate();
  const onNavigate = useCallback((href: string) => navigate(href), [navigate]);
  const { pathname } = useLocation();
  const states = useModuleStates();
  const behind = useRemoteHosts(countBehind).data ?? 0;
  const activeRemote = useRemoteHosts((hosts) =>
    hosts.find((host) => host.config.id === hostId)
  ).data;
  const remoteStatus = useMemo(() => {
    if (!activeRemote || activeRemote.status.state === "connected") {
      return undefined;
    }
    const view = remoteConnectionView(activeRemote);
    return {
      label: view.sidebarLabel,
      tone:
        view.tone === "destructive" ? ("error" as const) : ("idle" as const),
    };
  }, [activeRemote]);
  const selected = useHostSelection()?.hosts.find((host) => host.id === hostId);
  const linux = (activeRemote?.os ?? selected?.info.os) === "linux";
  const tools = useMemo(() => {
    const listed = LOCAL_TOOLS.filter(
      ({ id }) =>
        (id !== "alerts" || local || linux) &&
        (id !== "containers" || local || cgroups)
    );
    return withHostAttention(listed, behind);
  }, [local, linux, cgroups, behind]);
  const diskSpace = useEdition()?.disk_space;
  const { data: spaceStatus } = useSpaceStatus(diskSpace === true);
  const busy = spaceStatus?.phase === "scanning" ? SCAN_BUSY : undefined;
  const utilities = useMemo<readonly SidebarEntry[]>(
    () =>
      diskSpace === true
        ? [
            {
              id: "disk-space",
              href: "/dashboard/disk-space",
              label: "Disk space",
              icon: "disk-space",
              busy,
            },
          ]
        : [],
    [diskSpace, busy]
  );
  const configuredMs = useSettings((s) => s.sampling.interval_ms);
  const sampling = useSampling();
  const cpu = useCpu();
  const gpu = useGpu();
  const mem = useMemory();
  const power = usePower();
  const net = useNetwork();
  const disk = useDisk();
  const battery = useBattery();
  const memTotal = useHostRecord()?.info.mem_total_bytes ?? null;
  // A host without macOS memory pressure (a Linux agent) shows memory used.
  const memValue = mem.hasPressure
    ? mem.pressure
    : scaleOrNull(ratio(mem.used, memTotal), 100);
  const performanceLabel =
    sampling.performance === "low_power_mode"
      ? "Performance mode · Low Power"
      : "Performance mode";

  const module = (
    id: UiModule,
    icon: SidebarEntry["icon"],
    value: string | undefined
  ): SidebarEntry[] => {
    const state = states[id];
    if (state === "absent" || state === "unknown_chip") return [];
    const on = state === "on";
    return [
      {
        id,
        href: `/dashboard/${id}`,
        label: MODULE_META[id].name,
        icon,
        value: on ? value : undefined,
        disabled: !on,
      },
    ];
  };

  const groups = [
    {
      id: "nav",
      entries: NAV_ENTRIES,
    },
    {
      id: "modules",
      entries: [
        ...module("cpu", "cpu", formatPercent(cpu.total)),
        ...module("gpu", "gpu", formatPercent(gpu.util)),
        ...module("memory", "memory", formatPercent(memValue)),
        ...module(
          "power",
          "power",
          formatWatts(power.system, { compact: true })
        ),
        ...module("network", "network", compactRate(sumOrNull(net.rx, net.tx))),
        ...module(
          "disk",
          "disk",
          compactRate(sumOrNull(disk.read, disk.write))
        ),
        ...module("battery", "battery", formatPercent(battery.charge)),
      ],
    },
    {
      id: "tools",
      entries: tools,
    },
    ...(utilities.length
      ? [{ id: "utilities", label: "Utilities", entries: utilities }]
      : []),
  ];

  return (
    <Sidebar
      hostSwitcher={<HostSwitcher />}
      groups={groups}
      active={pathname.split("/")[2] ?? "overview"}
      status={{
        intervalMs: sampling.intervalMs ?? configuredMs ?? 1000,
        paused: sampling.paused,
        stale: sampling.stale,
        connection: sampling.connection,
        ...(remoteStatus ? { remoteStatus } : {}),
        onBattery: batteryBackoff({
          onBattery: sampling.onBattery,
          intervalMs: sampling.intervalMs,
          configuredMs,
        }),
      }}
      version={version}
      onNavigate={onNavigate}
      footerAction={<SidebarFeedbackAction />}
      footerNote={
        <PerformanceExplainer
          reason={sampling.performance}
          label={performanceLabel}
          side="right"
          onOpenSettings={() => navigate("/dashboard/settings")}
          className="ml-3.5 self-start text-left font-normal text-label text-muted-foreground"
        >
          {performanceLabel}
        </PerformanceExplainer>
      }
    />
  );
}
