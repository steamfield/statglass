import { chartLabel } from "@core/chart-label";
import {
  formatBytes,
  formatMarketingMemory,
  formatPercent,
  formatRate,
} from "@core/format";
import { selectCpu, selectMemory, selectNetwork } from "@core/live-selectors";
import { seriesWindow } from "@core/live-state";
import { MEM_TOTAL_BYTES } from "@core/mock/fixtures";
import { MINUTE_MS } from "@core/time-grid";
import type { JSX } from "react";
import { View } from "react-native";
import { CpuCard } from "@/cards/cpu-card";
import { MemoryCard } from "@/cards/memory-card";
import { NetworkCard } from "@/cards/network-card";
import { Text } from "@/ui/text";
import { useExampleLive } from "./use-example-live";

const ignorePress = () => {};
const chrome = {
  stale: false,
  onOpen: ignorePress,
  onToggleDensity: ignorePress,
  onLongPress: ignorePress,
};

export function ExamplePreview({ focused }: { focused: boolean }): JSX.Element {
  const live = useExampleLive(focused);

  const cpu = selectCpu(live);
  const memory = selectMemory(live);
  const network = selectNetwork(live);
  const window = seriesWindow(live, "cpu.total", MINUTE_MS);
  const cpuReading =
    cpu.total === null ? "unavailable" : formatPercent(cpu.total);
  const memoryReading =
    memory.used === null
      ? "unavailable"
      : `${formatBytes(memory.used, { unit: "GB", decimals: 1 })} of ${formatMarketingMemory(MEM_TOTAL_BYTES)}`;
  const networkReading =
    network.rx === null ? "unavailable" : `${formatRate(network.rx)} down`;
  return (
    <View
      accessible
      accessibilityLabel={`Example host: CPU ${cpuReading}, memory ${memoryReading}, network ${networkReading}`}
      pointerEvents="none"
      className="gap-2"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-2"
      >
        <Text variant="label">Example host</Text>
        <CpuCard
          {...chrome}
          compact={false}
          cpu={cpu}
          stream={{
            series: [{ key: "cpu.total", values: window.values, step: 1 }],
            tEndMs: window.tEndMs,
            intervalMs: window.intervalMs,
            yMax: 100,
            accent: "cpu",
            height: 36,
            ariaLabel: chartLabel({
              subject: "CPU",
              spanMs: MINUTE_MS,
              now: formatPercent(cpu.total),
            }),
            gridlines: [50],
          }}
        />
        <MemoryCard
          {...chrome}
          compact
          memory={memory}
          totalBytes={MEM_TOTAL_BYTES}
        />
        <NetworkCard {...chrome} compact network={network} bars={null} />
      </View>
    </View>
  );
}
