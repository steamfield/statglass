import { gpuCard } from "@core/popover/cards";
import { CardStream } from "@/cards/card-stream";
import { ModuleCard } from "@/cards/module-card";
import type { GpuCardProps } from "@/cards/types";
import { StatList } from "@/widgets/stat-list";

export function GpuCard({ gpu, stream, ...chrome }: GpuCardProps) {
  const card = gpuCard(gpu, { chartLabel: stream?.ariaLabel });
  return (
    <ModuleCard
      {...chrome}
      card="gpu"
      content={card}
      accent="gpu"
      compactDetails={stream?.ariaLabel}
    >
      <CardStream stream={stream} compact={chrome.compact} height={40} />
      {!chrome.compact && <StatList layout="grid" items={card.items} />}
    </ModuleCard>
  );
}
