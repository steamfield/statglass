import type { StatListData } from "@core/widget-models/stat-list";
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

/** Labelled figures as a wrapping strip or a grid of equal cells. */
export function StatList({
  items,
  layout = "strip",
  hero,
  accent,
}: StatListData) {
  const grid = layout === "grid";
  const { fontScale } = useWindowDimensions();
  const gridRows = grid && fontScale >= 1.5;
  const colors = themeColors[useColorScheme() ?? "light"];
  return (
    <View
      className={
        gridRows
          ? "gap-2"
          : grid
            ? "flex-row gap-2"
            : "flex-row flex-wrap items-end gap-x-5 gap-y-3"
      }
    >
      {hero && (
        <View className="shrink">
          <Text role="caption">{hero.label}</Text>
          <Text role={FIGURE_ROLE} style={styles.figure}>
            {hero.value}
            {hero.unit && <Text role={DETAIL_ROLE}> {hero.unit}</Text>}
          </Text>
        </View>
      )}
      {items.map((item) => (
        <View
          key={item.label}
          className={
            gridRows
              ? "flex-row flex-wrap items-baseline justify-between gap-x-2"
              : grid
                ? "min-w-0 flex-1 gap-0.5"
                : "shrink gap-0.5"
          }
        >
          <View className="flex-row items-center gap-1.5">
            {item.swatch && <BarSwatch step={item.swatch} accent={accent} />}
            <Text role="caption" className="shrink">
              {item.label}
            </Text>
          </View>
          <Text
            role={grid ? DETAIL_ROLE : FIGURE_ROLE}
            className="shrink"
            style={[
              styles.figure,
              { color: colors[item.muted ? "muted-foreground" : "foreground"] },
            ]}
          >
            {item.value}
            {item.secondary && (
              <Text role={DETAIL_ROLE}> {item.secondary}</Text>
            )}
            {item.unit && <Text role={DETAIL_ROLE}> {item.unit}</Text>}
          </Text>
        </View>
      ))}
    </View>
  );
}
