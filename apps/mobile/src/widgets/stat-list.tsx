import type { StatListBase, StatListData } from "@core/widget-models/stat-list";
import {
  StyleSheet,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";
import { BarSwatch } from "./stack-bar";

const FIGURE_ROLE = "cardFigure";
const DETAIL_ROLE = "label";

// NativeWind drops the CSS font-variant-numeric property.
const styles = StyleSheet.create({ figure: { fontVariant: ["tabular-nums"] } });

const ROW = "flex-row flex-wrap items-center justify-between gap-x-2";
const LAYOUT = {
  strip: {
    container: "flex-row flex-wrap items-end gap-x-5 gap-y-3",
    row: "shrink gap-0.5",
    value: FIGURE_ROLE,
  },
  grid: {
    container: "flex-row gap-2",
    row: "min-w-0 flex-1 gap-0.5",
    value: "value",
  },
  rows: { container: "gap-2", row: ROW, value: "value" },
  legend: { container: "gap-1", row: ROW, value: "caption" },
} as const;

/** Labelled figures in a wrapping strip, equal cells or stacked legend rows. */
export function StatList({
  items,
  layout = "strip",
  hero,
  accent,
}: StatListData | (StatListBase & { layout: "legend"; hero?: never })) {
  const { fontScale } = useWindowDimensions();
  const { container, row, value } =
    LAYOUT[layout === "grid" && fontScale >= 1.5 ? "rows" : layout];
  const colors = themeColors[useColorScheme() ?? "light"];
  const valueClassName =
    layout === "legend" ? "ml-auto shrink text-right" : "shrink";
  return (
    <View className={container}>
      {hero && (
        <View className="shrink">
          <Text variant="caption">{hero.label}</Text>
          <Text variant={FIGURE_ROLE} style={styles.figure}>
            {hero.value}
            {hero.unit && <Text variant={DETAIL_ROLE}> {hero.unit}</Text>}
          </Text>
        </View>
      )}
      {items.map((item) => (
        <View key={item.label} className={row}>
          <View className="shrink flex-row items-center gap-1.5">
            {item.swatch && <BarSwatch step={item.swatch} accent={accent} />}
            <Text variant="caption" className="shrink">
              {item.label}
            </Text>
          </View>
          <Text
            variant={value}
            className={valueClassName}
            style={[
              styles.figure,
              { color: colors[item.muted ? "muted-foreground" : "foreground"] },
            ]}
          >
            {item.value}
            {item.secondary && (
              <Text variant={DETAIL_ROLE}> {item.secondary}</Text>
            )}
            {item.unit && <Text variant={DETAIL_ROLE}> {item.unit}</Text>}
          </Text>
        </View>
      ))}
    </View>
  );
}
