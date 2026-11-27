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
import { type PhoneLive, subscribing, useHostLive } from "@/data/live";
import { useCompactStream, useNetworkBars } from "@/data/live-stream";

type LiveProps = CardChrome &
  Pick<ViewProps, "accessibilityActions" | "onAccessibilityAction"> & {
    host: HostId;
  };
const percentCeiling = { formatCeiling: formatPercent };
/**
 * A subscribe is on its way but no layout has arrived, so nothing says yet
 * which series the host reports. A failed subscribe isn't awaiting anything.
 */
const selectAwaiting = (state: PhoneLive) =>
  state.layoutNo === null && subscribing(state);

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
  macOs,
  ...chrome
}: LiveProps & { totalBytes: number | null; macOs: boolean }) {
  const reading = useHostLive(host, selectMemory, shallow);
  const awaiting = useHostLive(host, selectAwaiting);
  // Until the layout arrives, an expanded Mac card keeps the shape it will
  // have (pressure and composition rows, as dashes) so data doesn't resize it.
  const memory =
    awaiting && macOs && !chrome.compact
      ? { ...reading, composition: true, hasPressure: true }
      : reading;
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
  macOs,
  ...chrome
}: LiveProps & { includeBattery: boolean; macOs: boolean }) {
  const reading = useHostLive(host, selectPower, shallow);
  const awaiting = useHostLive(host, selectAwaiting);
  // A Mac reports power by component; keep those rails while the layout loads.
  const power = awaiting && macOs ? { ...reading, components: true } : reading;
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
    awaiting,
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
  macOs,
  ...props
}: LiveProps & {
  card: ModuleCardProps["card"];
  totalBytes: number | null;
  includeBattery: boolean;
  /** The host is a Mac, so its loading cards take the Mac's shape. */
  macOs: boolean;
}) {
  switch (card) {
    case "cpu":
      return <Cpu {...props} />;
    case "memory":
      return <Memory {...props} totalBytes={totalBytes} macOs={macOs} />;
    case "gpu":
      return <Gpu {...props} />;
    case "power":
      return <Power {...props} includeBattery={includeBattery} macOs={macOs} />;
    case "network":
      return <Network {...props} />;
    case "battery":
      return <Battery {...props} />;
  }
});
