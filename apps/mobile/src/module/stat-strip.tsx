import { MISSING } from "@core/format";
import type { SeriesHistoryStats } from "@core/generated/types";
import { seriesKeyString } from "@core/series-key";
import { View } from "react-native";
import { Text } from "@/ui/text";

export interface StatItem {
  label: string;
  value: string;
  seriesKey?: string;
  format?: (value: number) => string;
  formatAvg?: (value: number) => string;
}

function Stat({ label, value }: Pick<StatItem, "label" | "value">) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityValue={{ text: value }}
      className="shrink"
    >
      <Text variant="label">{label}</Text>
      <Text variant="value">{value}</Text>
    </View>
  );
}

export function StatStrip({
  lead,
  items,
  stats,
}: {
  lead: StatItem;
  items: readonly StatItem[];
  stats: readonly SeriesHistoryStats[];
}) {
  const summary =
    lead.seriesKey === undefined
      ? undefined
      : stats.find(({ key }) => seriesKeyString(key) === lead.seriesKey);
  return (
    <View className="gap-2">
      <View
        accessible
        accessibilityLabel={lead.label}
        accessibilityValue={{ text: lead.value }}
      >
        <Text variant="label">{lead.label}</Text>
        <Text variant="heroFigure">{lead.value}</Text>
      </View>
      <View className="flex-row flex-wrap gap-x-5 gap-y-2">
        {items.map((item) => (
          <Stat key={item.label} {...item} />
        ))}
        {lead.format && (
          <>
            <Stat
              label="Avg"
              value={
                summary?.avg == null
                  ? MISSING
                  : (lead.formatAvg ?? lead.format)(summary.avg)
              }
            />
            <Stat
              label="Peak"
              value={
                summary?.peak == null ? MISSING : lead.format(summary.peak)
              }
            />
          </>
        )}
      </View>
    </View>
  );
}
