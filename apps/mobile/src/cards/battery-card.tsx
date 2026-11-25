import { batteryCard } from "@core/popover/cards";
import { useColorScheme, View } from "react-native";
import { ModuleCard } from "@/cards/module-card";
import type { BatteryCardProps } from "@/cards/types";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";
import { WidgetAccent } from "@/widgets/accent";
import { MeterTrack } from "@/widgets/meter-track";
import { StatList } from "@/widgets/stat-list";

const CHARGE_ROLE = "label";

export function BatteryCard({ battery, source, ...chrome }: BatteryCardProps) {
  const card = batteryCard(battery, { powerSource: source });
  return (
    <ModuleCard
      {...chrome}
      card="battery"
      content={card}
      accent="battery"
      compactDetails={card.status}
    >
      {chrome.compact ? (
        <MeterTrack fraction={card.chargeFraction} wide />
      ) : (
        <BatteryDetails card={card} />
      )}
    </ModuleCard>
  );
}

/** The battery section of both cards, with its own accent in the Power card. */
export function BatteryDetails({
  card,
  showCharge = false,
}: {
  card: ReturnType<typeof batteryCard>;
  showCharge?: boolean;
}) {
  const { foreground } = themeColors[useColorScheme() ?? "light"];
  return (
    <WidgetAccent value="battery">
      {showCharge && (
        <View className="flex-row flex-wrap justify-between gap-2">
          <Text variant={CHARGE_ROLE}>{card.title}</Text>
          <Text
            variant={CHARGE_ROLE}
            // NativeWind drops the CSS font-variant-numeric property.
            style={{ color: foreground, fontVariant: ["tabular-nums"] }}
          >
            {card.headline}
          </Text>
        </View>
      )}
      <MeterTrack fraction={card.chargeFraction} wide />
      <StatList layout="grid" items={card.items} />
    </WidgetAccent>
  );
}
