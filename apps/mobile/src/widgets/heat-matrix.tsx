import type { GapBandModel } from "@core/widget-models/gap-band";
import type { HeatMatrixModel } from "@core/widget-models/heat-matrix";
import { useColorScheme, View } from "react-native";
import Svg, { Defs, Path, Pattern, Rect } from "react-native-svg";
import { Text } from "@/ui/text";
import { resolveColor } from "./colors";

const CELL_HEIGHT = 10;
const SWATCH_WIDTH = 14;
const GAP_PATTERN = "heat-gap";
const GAP_FILL = `url(#${GAP_PATTERN})`;
// A diagonal tile repeats every 4 pt across the stripes.
const GAP_TILE = 4 * Math.SQRT2;
const GAP_STRIPE = [
  "M-1 1L1 -1",
  `M0 ${GAP_TILE}L${GAP_TILE} 0`,
  `M${GAP_TILE - 1} ${GAP_TILE + 1}L${GAP_TILE + 1} ${GAP_TILE - 1}`,
].join(" ");

export function HeatMatrix({
  model,
  height,
  gapBands = [],
}: {
  model: HeatMatrixModel;
  height: number;
  gapBands?: readonly Pick<GapBandModel, "key" | "leftFrac" | "widthFrac">[];
}) {
  const scheme = useColorScheme() ?? "light";
  const { cells, rows, columns, legend, loading, notice } = model;
  const fill = resolveColor(
    { kind: "accent", step: 1, ink: false },
    scheme,
    model.accent
  );
  const track = resolveColor({ kind: "token", name: "track" }, scheme);
  const slotWidth = 100 / columns;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={model.spoken}
      accessibilityValue={{ text: model.spokenValue }}
      accessibilityState={{ busy: loading }}
      className="justify-center gap-1"
      style={{ minHeight: height }}
    >
      {rows.length > 0 && (
        <View className="flex-row items-center justify-end gap-1">
          <Text variant="axis">{legend.min}</Text>
          <Svg
            accessible={false}
            height={CELL_HEIGHT}
            width={legend.stops.length * SWATCH_WIDTH}
          >
            {legend.stops.map((alpha, index) => (
              <Rect
                key={alpha}
                x={index * SWATCH_WIDTH}
                width={SWATCH_WIDTH - 2}
                height={CELL_HEIGHT}
                rx={2}
                fill={fill}
                fillOpacity={alpha}
              />
            ))}
          </Svg>
          <Text variant="axis">{legend.max}</Text>
        </View>
      )}
      {rows.map((row, index) => (
        <View
          key={row.key}
          className={`flex-row items-center gap-2 ${row.startsGroup ? "mt-2" : ""}`}
        >
          <Text variant="caption" className="w-1/5">
            {row.label}
          </Text>
          <View className="flex-1">
            <Svg accessible={false} height={CELL_HEIGHT} width="100%">
              <Defs>
                <Pattern
                  id={GAP_PATTERN}
                  width={GAP_TILE}
                  height={GAP_TILE}
                  patternUnits="userSpaceOnUse"
                >
                  <Path
                    testID="heat-gap-stripe"
                    d={GAP_STRIPE}
                    stroke={track}
                  />
                </Pattern>
              </Defs>
              {cells
                .slice(index * columns, (index + 1) * columns)
                .map(({ col, alpha }) => {
                  const paint = loading
                    ? track
                    : alpha === null
                      ? GAP_FILL
                      : fill;
                  return (
                    <Rect
                      key={model.firstKey + col}
                      x={`${col * slotWidth}%`}
                      width={`${slotWidth * 0.94}%`}
                      height={CELL_HEIGHT}
                      rx={1}
                      fill={paint}
                      fillOpacity={alpha ?? 1}
                      testID={
                        loading
                          ? "heat-loading"
                          : paint === GAP_FILL
                            ? "heat-gap"
                            : "heat-cell"
                      }
                    />
                  );
                })}
              {!loading &&
                gapBands.map(({ key, leftFrac, widthFrac }) => (
                  <Rect
                    key={key}
                    x={`${leftFrac * 100}%`}
                    width={`${widthFrac * 100}%`}
                    height={CELL_HEIGHT}
                    fill={GAP_FILL}
                    testID="heat-gap-band"
                  />
                ))}
            </Svg>
          </View>
          <Text variant="value" className="w-1/5 text-right">
            {row.current}
          </Text>
        </View>
      ))}
      {notice && <Text variant="caption">{notice}</Text>}
    </View>
  );
}
