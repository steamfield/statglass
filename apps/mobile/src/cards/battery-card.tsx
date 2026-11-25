import { ratio } from "@core/chart-math";
import { formatPercent, MISSING } from "@core/format";
import { batteryTime } from "@core/format/battery";
import type { PowerSource } from "@core/generated/types";
import type { BatterySelection } from "@core/live-selectors";
import type { StatListItem } from "@core/widget-models/stat-list";
import { useColorScheme, View } from "react-native";
import { ModuleCard } from "@/cards/module-card";
import type { BatteryCardProps } from "@/cards/types";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";
import { MeterTrack, WidgetAccent } from "@/widgets/meter-track";
import { describeStats, StatList } from "@/widgets/stat-list";

const CHARGE_ROLE = "label";

export function BatteryCard({ battery, source, ...chrome }: BatteryCardProps) {
  const items = batteryStats(battery, source);
  return (
    <ModuleCard
      {...chrome}
      title="Battery"
      accent="battery"
      headline={formatPercent(battery.charge)}
      spokenDetails={describeStats(items)}
    >
      <BatteryDetails charge={battery.charge} items={items} />
    </ModuleCard>
  );
}

export function batteryStats(
  battery: BatterySelection,
  source: PowerSource | null
): StatListItem[] {
  return [
    batteryTime(battery, source),
    { label: "Health", value: formatPercent(battery.health) },
    {
      label: "Cycles",
      value:
        battery.cycles === null ? MISSING : String(Math.round(battery.cycles)),
    },
  ];
}

/** The battery section of both cards, with its own accent in the Power card. */
export function BatteryDetails({
  charge,
  items,
  showCharge = false,
}: {
  charge: number | null;
  items: StatListItem[];
  showCharge?: boolean;
}) {
  const { foreground } = themeColors[useColorScheme() ?? "light"];
  return (
    <WidgetAccent value="battery">
      {showCharge && (
        <View className="flex-row flex-wrap justify-between gap-2">
          <Text role={CHARGE_ROLE}>Battery</Text>
          <Text
            role={CHARGE_ROLE}
            // NativeWind drops the CSS font-variant-numeric property.
            style={{ color: foreground, fontVariant: ["tabular-nums"] }}
          >
            {formatPercent(charge)}
          </Text>
        </View>
      )}
      <MeterTrack fraction={ratio(charge, 100)} />
      <StatList layout="grid" items={items} />
    </WidgetAccent>
  );
}
