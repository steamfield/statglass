import { cpuCard } from "@core/popover/cards";
import { View } from "react-native";
import { ModuleCard } from "@/cards/module-card";
import type { CpuCardProps } from "@/cards/types";
import { InlineBar } from "@/widgets/inline-bar";
import { StreamArea } from "@/widgets/stream-area";

export function CpuCard({ cpu, stream, ...chrome }: CpuCardProps) {
  const card = cpuCard(cpu, {
    compact: chrome.compact,
    chartLabel: stream?.ariaLabel,
  });
  return (
    <ModuleCard
      {...chrome}
      title={card.title}
      accent="cpu"
      headline={card.headline}
      spokenDetails={chrome.compact ? "" : card.spoken}
    >
      {stream && <StreamArea {...stream} />}
      <View className="gap-1">
        {card.bars.map((bar) => (
          <InlineBar key={bar.label} model={bar} />
        ))}
      </View>
    </ModuleCard>
  );
}
