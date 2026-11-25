import { gpuCard } from "@core/popover/cards";
import { ModuleCard } from "@/cards/module-card";
import type { GpuCardProps } from "@/cards/types";
import { StatList } from "@/widgets/stat-list";
import { StreamArea } from "@/widgets/stream-area";

export function GpuCard({ gpu, stream, ...chrome }: GpuCardProps) {
  const card = gpuCard(gpu, { chartLabel: stream?.ariaLabel });
  return (
    <ModuleCard
      {...chrome}
      title={card.title}
      accent="gpu"
      headline={card.headline}
      spokenDetails={card.spoken}
    >
      {stream && <StreamArea {...stream} />}
      <StatList layout="grid" items={card.items} />
    </ModuleCard>
  );
}
