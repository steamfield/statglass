import { memoryCard } from "@core/popover/cards";
import { View } from "react-native";
import { ModuleCard, StatusIcon } from "@/cards/module-card";
import type { MemoryCardProps } from "@/cards/types";
import { Text } from "@/ui/text";
import { InlineBar } from "@/widgets/inline-bar";
import { MeterTrack } from "@/widgets/meter-track";
import { StackBar } from "@/widgets/stack-bar";
import { StatList } from "@/widgets/stat-list";

export function MemoryCard({ memory, totalBytes, ...chrome }: MemoryCardProps) {
  const card = memoryCard(memory, { totalBytes, compact: chrome.compact });
  const pressure = card.bars[0];
  const legend = [
    ...card.segments.map(({ label, value, step }) => ({
      label,
      value,
      swatch: step,
    })),
    ...card.items.map((item) => ({ ...item, swatch: "hatch" as const })),
  ];
  return (
    <ModuleCard
      {...chrome}
      card="memory"
      content={card}
      accent="mem"
      unit={card.capacity ?? card.usedUnit}
      compactDetails={card.compactPressure ?? undefined}
    >
      {chrome.compact && (
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <MeterTrack fraction={card.usedFraction} />
          </View>
          {card.compactPressure && (
            <Text variant="caption" className="shrink">
              {card.compactPressure}
            </Text>
          )}
        </View>
      )}
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
      {legend.length > 0 && (
        <>
          <StackBar segments={card.segments} />
          <StatList layout="legend" items={legend} />
        </>
      )}
    </ModuleCard>
  );
}
