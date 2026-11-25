import { cpuCard } from "@core/popover/cards";
import { View } from "react-native";
import { CardStream } from "@/cards/card-stream";
import { ModuleCard } from "@/cards/module-card";
import type { CpuCardProps } from "@/cards/types";
import { InlineBar } from "@/widgets/inline-bar";

export function CpuCard({ cpu, stream, ...chrome }: CpuCardProps) {
  const card = cpuCard(cpu, {
    compact: chrome.compact,
    chartLabel: stream?.ariaLabel,
  });
  return (
    <ModuleCard
      {...chrome}
      card="cpu"
      content={card}
      accent="cpu"
      compactDetails={stream?.ariaLabel}
    >
      <CardStream stream={stream} compact={chrome.compact} height={52} />
      {card.bars.length > 0 && (
        <View className="gap-1">
          {card.bars.map((bar) => (
            <InlineBar key={bar.label} model={bar} />
          ))}
        </View>
      )}
    </ModuleCard>
  );
}
