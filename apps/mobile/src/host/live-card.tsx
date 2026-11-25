import { formatPercent } from "@core/format";
import type { HostId } from "@core/generated/types";
import {
  selectBattery,
  selectCpu,
  selectGpu,
  selectMemory,
  selectNetwork,
  selectPower,
  selectPowerSource,
} from "@core/live-selectors";
import {
  batteryCard,
  cpuCard,
  gpuCard,
  memoryCard,
  networkCard,
  powerCard,
} from "@core/popover/cards";
import { memo } from "react";
import type { ViewProps } from "react-native";
import { shallow } from "zustand/shallow";
import { BatteryCard } from "@/cards/battery-card";
import { CpuCard } from "@/cards/cpu-card";
import { GpuCard } from "@/cards/gpu-card";
import { MemoryCard } from "@/cards/memory-card";
import { NetworkCard } from "@/cards/network-card";
import { PowerCard } from "@/cards/power-card";
import type {
  BatteryCardProps,
  CardChrome,
  CpuCardProps,
  GpuCardProps,
  MemoryCardProps,
  ModuleCardProps,
  NetworkCardProps,
  PowerCardProps,
} from "@/cards/types";
import { useHostLive } from "@/data/live";
import { useCompactStream, useNetworkBars } from "@/data/live-stream";

type LiveProps = CardChrome &
  Pick<ViewProps, "accessibilityActions" | "onAccessibilityAction"> & {
    host: HostId;
  };
const percentCeiling = { formatCeiling: formatPercent };

// The raw readings and stream props still feed the scaffold's card bodies.
// Content and controls use the same ModuleCardProps contract as the polish.
const CpuPresentation = memo(function CpuPresentation(props: CpuCardProps) {
  const presentation: ModuleCardProps = {
    ...props,
    card: "cpu",
    content: cpuCard(props.cpu, {
      compact: props.compact,
      chartLabel: props.stream?.ariaLabel,
    }),
  };
  return <CpuCard {...props} {...presentation} />;
});

function Cpu({ host, ...chrome }: LiveProps) {
  const cpu = useHostLive(host, selectCpu, shallow);
  const stream = useCompactStream(host, {
    ...percentCeiling,
    accent: "cpu",
    seriesKey: "cpu.total",
    subject: "CPU",
    now: formatPercent(cpu.total),
    height: 52,
  });
  return <CpuPresentation {...chrome} cpu={cpu} stream={stream} />;
}

function Memory({
  host,
  totalBytes,
  ...chrome
}: LiveProps & { totalBytes: number | null }) {
  const memory = useHostLive(host, selectMemory, shallow);
  const props: MemoryCardProps & ModuleCardProps = {
    ...chrome,
    card: "memory",
    content: memoryCard(memory, { totalBytes, compact: chrome.compact }),
    memory,
    totalBytes,
  };
  return <MemoryCard {...props} />;
}

const GpuPresentation = memo(function GpuPresentation(props: GpuCardProps) {
  const presentation: ModuleCardProps = {
    ...props,
    card: "gpu",
    content: gpuCard(props.gpu, { chartLabel: props.stream?.ariaLabel }),
  };
  return <GpuCard {...props} {...presentation} />;
});

function Gpu({ host, ...chrome }: LiveProps) {
  const gpu = useHostLive(host, selectGpu, shallow);
  const stream = useCompactStream(host, {
    ...percentCeiling,
    accent: "gpu",
    seriesKey: "gpu.util",
    subject: "GPU",
    now: formatPercent(gpu.util),
    height: 40,
    yMax: 100,
  });
  return <GpuPresentation {...chrome} gpu={gpu} stream={stream} />;
}

function Power({
  host,
  includeBattery,
  ...chrome
}: LiveProps & { includeBattery: boolean }) {
  const power = useHostLive(host, selectPower, shallow);
  const source = useHostLive(host, selectPowerSource);
  const battery = useHostLive(
    host,
    includeBattery ? selectBattery : noBattery,
    shallow
  );
  const props: PowerCardProps & ModuleCardProps = {
    ...chrome,
    card: "power",
    content: powerCard(power, { battery, powerSource: source }),
    power,
    source,
    battery,
  };
  return <PowerCard {...props} />;
}

const noBattery = () => null;

const NetworkPresentation = memo(function NetworkPresentation(
  props: NetworkCardProps
) {
  const presentation: ModuleCardProps = {
    ...props,
    card: "network",
    content: networkCard(props.network, { chartLabel: props.bars?.ariaLabel }),
  };
  return <NetworkCard {...props} {...presentation} />;
});

function Network({ host, ...chrome }: LiveProps) {
  const network = useHostLive(host, selectNetwork, shallow);
  const bars = useNetworkBars(host);
  return <NetworkPresentation {...chrome} bars={bars} network={network} />;
}

function Battery({ host, ...chrome }: LiveProps) {
  const battery = useHostLive(host, selectBattery, shallow);
  const source = useHostLive(host, selectPowerSource);
  const props: BatteryCardProps & ModuleCardProps = {
    ...chrome,
    card: "battery",
    content: batteryCard(battery, { powerSource: source }),
    source,
    battery,
  };
  return <BatteryCard {...props} />;
}

export const LiveCard = memo(function LiveCard({
  card,
  totalBytes,
  includeBattery,
  ...props
}: LiveProps & {
  card: ModuleCardProps["card"];
  totalBytes: number | null;
  includeBattery: boolean;
}) {
  switch (card) {
    case "cpu":
      return <Cpu {...props} />;
    case "memory":
      return <Memory {...props} totalBytes={totalBytes} />;
    case "gpu":
      return <Gpu {...props} />;
    case "power":
      return <Power {...props} includeBattery={includeBattery} />;
    case "network":
      return <Network {...props} />;
    case "battery":
      return <Battery {...props} />;
  }
});
