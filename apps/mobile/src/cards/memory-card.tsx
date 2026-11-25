import { memoryCard } from "@core/popover/cards";
import { View } from "react-native";
import { ModuleCard, StatusIcon } from "@/cards/module-card";
import type { MemoryCardProps } from "@/cards/types";
import { InlineBar } from "@/widgets/inline-bar";
import { StackBar } from "@/widgets/stack-bar";

export function MemoryCard({ memory, totalBytes, ...chrome }: MemoryCardProps) {
  const card = memoryCard(memory, { totalBytes, compact: chrome.compact });
  const pressure = card.bars[0];
  return (
    <ModuleCard
      {...chrome}
      title={card.title}
      accent="mem"
      headline={card.headline}
      spokenDetails={chrome.compact ? "" : card.spoken}
      unit={card.capacity ?? card.usedUnit}
    >
      {pressure && (
        <View className="flex-row items-start gap-1.5">
          {card.pressureStatus && (
            <View className="pt-0.5">
              <StatusIcon kind={card.pressureStatus} />
            </View>
          )}
          <View className="min-w-0 flex-1">
            <InlineBar model={pressure} />
          </View>
        </View>
      )}
      <StackBar
        showLegend
        segments={[...card.segments]}
        extraLegend={[...card.items]}
      />
    </ModuleCard>
  );
}
