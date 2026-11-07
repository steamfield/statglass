/**
 * The six Overview cards (plan 4.5), each subscribed to its
 * own slice so one module's tick does not re-render the others.
 */

import { formatBytes } from "@core/format";
import type { LiveProcess } from "@core/generated/bindings";
import { useNavigate } from "react-router";
import { useShallow } from "zustand/react/shallow";
import {
  CPU_HERO,
  GPU_HERO,
  MEMORY_PRESSURE_HERO,
  memoryUsedHero,
  POWER_HERO,
} from "~/components/charts/module-hero";
import { useHostRecord } from "~/hooks/use-host-record";
import { useModuleEnd } from "~/hooks/use-module-end";
import {
  useProcessColumnCaps,
  useProcessGpu,
  useProcessNetwork,
} from "~/hooks/use-process-interest";
import { useReadFailure } from "~/hooks/use-read-failure";
import { useUnits } from "~/hooks/use-units";
import { useHost } from "~/stores/host-store";
import {
  clusterFreqKey,
  held,
  keysOf,
  selectVolumeCapacity,
  useCpu,
  useGpu,
  useMemory,
  useNetwork,
  usePower,
  usePowerSource,
  usePrimaryIface,
  useSensors,
} from "~/stores/live-selectors";
import type { Corner } from "~/widgets/lib/accent";
import { MetricCard } from "~/widgets/metric-card";
import {
  type ClusterInput,
  cpuCard,
  diskCard,
  gpuCard,
  memoryCard,
  networkCard,
  powerCard,
} from "../_lib/card-props";
import { sensorPowerCard, usedMemoryCard } from "../_lib/host-card-props";
import { ifaceRates, linkRate, thermalSensors } from "../_lib/selectors";
import {
  OverviewDiskChart,
  OverviewHistoryChart,
  OverviewNetworkChart,
  useOverviewDisk,
} from "./overview-history-charts";

const NO_PROCESSES: readonly LiveProcess[] = [];

function useProcesses(): readonly LiveProcess[] {
  return useHost((s) => s.processes?.rows ?? NO_PROCESSES);
}

interface CardProps {
  origin: Corner;
  windowMs: number;
}

function useOpen() {
  const navigate = useNavigate();
  return (href: string) => navigate(href);
}

export function OverviewCpuCard({ origin, windowMs }: CardProps) {
  const cpu = useCpu();
  const host = useHostRecord();
  const topology = host?.info.cpu_topology ?? [];
  const p = topology.find((c) => c.kind === "performance");
  const e = topology.find((c) => c.kind === "efficiency");
  const freq = useHost(
    useShallow((s) => ({
      p: p ? held(s, clusterFreqKey(p.name)) : null,
      e: e ? held(s, clusterFreqKey(e.name)) : null,
    }))
  );
  // A host whose cores are all one kind (`uniform`, D-116) has one cluster.
  const only = !p || !e ? topology[0] : undefined;
  const onlyFreq = useHost((s) =>
    only ? held(s, clusterFreqKey(only.name)) : null
  );
  const clusters: [ClusterInput, ClusterInput] | [ClusterInput] = only
    ? [{ label: "Frequency", freqHz: onlyFreq }]
    : [
        { label: "P-cluster", freqHz: freq.p },
        { label: "E-cluster", freqHz: freq.e },
      ];
  const props = cpuCard({
    ...cpu,
    coreCount: topology.reduce((n, c) => n + c.cores.length, 0),
    clusters,
    processes: useProcesses(),
  });
  return (
    <MetricCard
      {...props}
      origin={origin}
      unit={useNowUnit()}
      chart={
        <OverviewHistoryChart
          spec={CPU_HERO}
          windowMs={windowMs}
          accent="cpu"
        />
      }
      notice={useReadFailure("cpu.total")}
      href="/dashboard/cpu"
      onOpen={useOpen()}
    />
  );
}

/** Process batches do not touch this card when the host cannot measure GPU shares. */
export function OverviewGpuCard({ origin, windowMs }: CardProps) {
  const gpu = useGpu();
  const perProcess = useProcessGpu();
  const processes = useHost((s) =>
    perProcess ? (s.processes?.rows ?? NO_PROCESSES) : null
  );
  const props = gpuCard({ ...gpu, processes });
  return (
    <MetricCard
      {...props}
      origin={origin}
      unit={useNowUnit()}
      chart={
        <OverviewHistoryChart
          spec={GPU_HERO}
          windowMs={windowMs}
          accent="gpu"
        />
      }
      notice={useReadFailure("gpu.util")}
      href="/dashboard/gpu"
      onOpen={useOpen()}
    />
  );
}

export function OverviewMemoryCard({ origin, windowMs }: CardProps) {
  const mem = useMemory();
  const host = useHostRecord();
  const { bytes } = useUnits();
  const binary = bytes === "GiB";
  const input = {
    ...mem,
    binary,
    processes: useProcesses(),
  };
  // A Mac always has the composition; a Linux layout has no `mem.app`.
  const mac =
    host === undefined || host.info.os === "mac_os" || mem.composition;
  const props = mac ? memoryCard(input) : usedMemoryCard(input);
  const spec = mac
    ? MEMORY_PRESSURE_HERO
    : memoryUsedHero(host.info.mem_total_bytes, (v) =>
        formatBytes(v, { units: bytes })
      );
  return (
    <MetricCard
      {...props}
      origin={origin}
      unit={useNowUnit()}
      chart={
        <OverviewHistoryChart spec={spec} windowMs={windowMs} accent="mem" />
      }
      notice={useReadFailure("mem.used")}
      href="/dashboard/memory"
      onOpen={useOpen()}
    />
  );
}

export function OverviewPowerCard({ origin, windowMs }: CardProps) {
  const p = usePower();
  const sensors = useSensors();
  const powerSource = usePowerSource();
  const { temperature } = useUnits();
  // A layout with sensors but no fan series is a Mac without fans.
  const hasSensorLayout = useHost(
    (s) => keysOf(s, "thermal.hottest").length > 0
  );
  const energy = useProcessColumnCaps().energy;
  const processes = useHost((s) =>
    energy ? (s.processes?.rows ?? NO_PROCESSES) : NO_PROCESSES
  );
  const thermal = useHost(useShallow(thermalSensors));
  const common = {
    system: p.system,
    fanRpm: sensors.fanRpm,
    passive: hasSensorLayout && sensors.fanCount === 0,
    powerSource,
    temperature,
  } as const;
  // Without a component split or process energy (a Linux agent, D-116) the
  // card is built from the system draw and the temperature sensors.
  const props =
    p.components || energy
      ? powerCard({
          ...common,
          cpu: p.cpu,
          gpu: p.gpu,
          dram: p.dram,
          hottestC: sensors.hottest,
          processes,
        })
      : sensorPowerCard({
          ...common,
          sensors: Object.entries(thermal).map(([name, c]) => ({ name, c })),
        });
  return (
    <MetricCard
      {...props}
      origin={origin}
      unit={useNowUnit(props.unit)}
      chart={
        <OverviewHistoryChart
          spec={POWER_HERO}
          windowMs={windowMs}
          accent="power"
        />
      }
      notice={useReadFailure("power.system")}
      href="/dashboard/power"
      onOpen={useOpen()}
    />
  );
}

export function OverviewNetworkCard({ origin, windowMs }: CardProps) {
  const primary = usePrimaryIface();
  const net = useNetwork();
  const rates = useHost(useShallow(ifaceRates));
  const link = useHost((s) => linkRate(s, primary));
  const { rate } = useUnits();
  const perProcess = useProcessNetwork();
  // Without per-process network a process batch does not touch this card.
  const processes = useHost((s) =>
    perProcess ? (s.processes?.rows ?? NO_PROCESSES) : null
  );
  const names = [
    ...new Set(Object.keys(rates).map((k) => k.slice(k.indexOf("|") + 1))),
  ];
  const interfaces = names.map((iface) => ({
    iface,
    rx: rates[`rx|${iface}`] ?? null,
    tx: rates[`tx|${iface}`] ?? null,
  }));
  const props = networkCard({
    primary: interfaces.find((i) => i.iface === primary) ?? null,
    linkBps: link,
    total: { rx: net.rx, tx: net.tx },
    interfaces,
    rate,
    processes,
  });
  return (
    <MetricCard
      {...props}
      origin={origin}
      unit={useNowUnit()}
      chart={<OverviewNetworkChart windowMs={windowMs} />}
      href="/dashboard/network"
      onOpen={useOpen()}
    />
  );
}

export function OverviewDiskCard({ origin, windowMs }: CardProps) {
  const { read, write, query, range, fixedEnd, devicesFailed } =
    useOverviewDisk(windowMs);
  const boot = useHostRecord()?.info.boot_mounts?.[0] ?? null;
  const vol = useHost(useShallow((s) => selectVolumeCapacity(s, boot)));
  const units = useUnits();
  const props = diskCard({
    read,
    write,
    totalBytes: vol.total,
    usedBytes: vol.used,
    bytes: units.bytes,
    rate: units.rate,
    processes: useProcesses(),
  });
  const diskIo = useProcessColumnCaps().diskIo;
  return (
    <MetricCard
      {...props}
      origin={origin}
      unit={useNowUnit()}
      chart={
        <OverviewDiskChart
          query={query}
          range={range}
          fixedEnd={fixedEnd}
          devicesFailed={devicesFailed}
        />
      }
      list={
        diskIo
          ? props.list
          : {
              caption: "Now",
              ariaLabel: "Top processes by disk I/O",
              rows: [],
              note: "Disk rates by process aren't readable on this host",
            }
      }
      href="/dashboard/disk"
      onOpen={useOpen()}
    />
  );
}

function useNowUnit(unit = ""): string {
  return `${unit}${useModuleEnd() === null ? "" : " now"}`;
}
