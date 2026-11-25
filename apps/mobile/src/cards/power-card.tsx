import { powerCard } from "@core/popover/cards";
import { BatteryDetails } from "@/cards/battery-card";
import { ModuleCard } from "@/cards/module-card";
import type { PowerCardProps } from "@/cards/types";
import { Text } from "@/ui/text";
import { StackBar } from "@/widgets/stack-bar";
import { StatList } from "@/widgets/stat-list";

export function PowerCard({
  power,
  source,
  battery,
  ...chrome
}: PowerCardProps) {
  const card = powerCard(power, { battery, powerSource: source });
  return (
    <ModuleCard
      {...chrome}
      card="power"
      content={card}
      accent="power"
      unit={card.headlineUnit}
    >
      <StackBar segments={[...card.segments]} />
      <StatList layout="grid" items={card.items} />
      {card.battery && <BatteryDetails card={card.battery} showCharge />}
      {card.note && <Text variant="caption">{card.note}</Text>}
    </ModuleCard>
  );
}
