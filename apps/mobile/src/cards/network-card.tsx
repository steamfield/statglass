import { networkCard } from "@core/popover/cards";
import { ModuleCard } from "@/cards/module-card";
import type { NetworkCardProps } from "@/cards/types";
import { Text } from "@/ui/text";
import { MirrorBars } from "@/widgets/mirror-bars";
import { StatList } from "@/widgets/stat-list";

export function NetworkCard({ network, bars, ...chrome }: NetworkCardProps) {
  const card = networkCard(network, { chartLabel: bars?.ariaLabel });
  // Keep each rate together when Dynamic Type wraps the headline.
  const headline = card.headline
    .replaceAll(" ", "\u00a0")
    .replace("\u00a0·\u00a0", " · ");
  return (
    <ModuleCard
      {...chrome}
      title={card.title}
      accent="net"
      headline={headline}
      spokenHeadline={card.spokenHeadline}
      spokenDetails={chrome.compact ? "" : card.spoken}
      headlineContent={
        chrome.compact ? null : (
          <StatList
            layout="grid"
            items={card.items.map(({ label, joinedValue }) => ({
              label,
              value: joinedValue.replace(" ", "\u00a0"),
            }))}
          />
        )
      }
    >
      <Text role="caption">{card.subtitle}</Text>
      {bars && <MirrorBars {...bars} />}
    </ModuleCard>
  );
}
