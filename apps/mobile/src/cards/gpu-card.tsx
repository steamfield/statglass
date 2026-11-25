import { formatGhz, formatPercent, formatWatts } from "@core/format";
import { ModuleCard } from "@/cards/module-card";
import type { GpuCardProps } from "@/cards/types";
import { describeStats, StatList } from "@/widgets/stat-list";
import { StreamArea } from "@/widgets/stream-area";

export function GpuCard({ gpu, stream, ...chrome }: GpuCardProps) {
  const items = [
    { label: "Freq", value: formatGhz(gpu.freqHz) },
    { label: "Power", value: formatWatts(gpu.powerW) },
    { label: "Render", value: formatPercent(gpu.render) },
  ];
  const details = describeStats(items);
  return (
    <ModuleCard
      {...chrome}
      title="GPU"
      accent="gpu"
      headline={formatPercent(gpu.util)}
      spokenDetails={
        stream?.ariaLabel ? `${details}, ${stream.ariaLabel}` : details
      }
    >
      {stream && <StreamArea {...stream} />}
      <StatList layout="grid" items={items} />
    </ModuleCard>
  );
}
