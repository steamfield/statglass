import { networkCard } from "@core/popover/cards";
import { View } from "react-native";
import { ModuleCard } from "@/cards/module-card";
import type { NetworkCardProps } from "@/cards/types";
import { Text } from "@/ui/text";
import { MirrorBars, MirrorBarsPlot } from "@/widgets/mirror-bars";

export function NetworkCard({ network, bars, ...chrome }: NetworkCardProps) {
  const card = networkCard(network, { chartLabel: bars?.ariaLabel });
  // Keep each rate together when Dynamic Type wraps the headline.
  const headline = card.headline
    .replaceAll(" ", "\u00a0")
    .replace("\u00a0·\u00a0", " · ");
  return (
    <ModuleCard
      {...chrome}
      card="network"
      content={card}
      accent="net"
      headline={headline}
      spokenHeadline={card.spokenHeadline}
      compactDetails={bars?.ariaLabel}
    >
      {chrome.compact ? (
        bars && <MirrorBarsPlot {...bars} upHeight={6} downHeight={8} />
      ) : (
        <>
          <Text variant="caption">{card.subtitle}</Text>
          {bars ? (
            <MirrorBars {...bars} />
          ) : (
            <View className="flex-row flex-wrap justify-between gap-x-2">
              {card.items.map(({ label }) => (
                <Text key={label} variant="axis">
                  {label}
                </Text>
              ))}
            </View>
          )}
        </>
      )}
    </ModuleCard>
  );
}
