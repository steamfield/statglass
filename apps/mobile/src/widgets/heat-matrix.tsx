import type { PlacedGapBand } from "@core/widget-models/gap-band";
import type { HeatMatrixModel } from "@core/widget-models/heat-matrix";
import { useState } from "react";
import { useColorScheme, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Defs, Path, Pattern, Rect } from "react-native-svg";
import { Text } from "@/ui/text";
import { useReveal } from "@/widgets/lib/reveal";
import { resolveColor } from "./colors";
import { GapBands } from "./gap-bands";

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
  /** Labelled gaps drawn as one band over every row, as on the desktop. */
  gapBands?: readonly PlacedGapBand[];
}) {
  const [rowsBox, setRowsBox] = useState({ y: 0, height: 0 });
  const scheme = useColorScheme() ?? "light";
  const { cells, rows, columns, legend, loading, notice } = model;
  const reveal = useReveal(loading);
  const fill = resolveColor(
    { kind: "accent", step: 1, ink: false },
    scheme,
    model.accent
  );
  const track = resolveColor({ kind: "token", name: "track" }, scheme);
  const slotWidth = 100 / columns;
  return (
    <View className="relative">
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
        <View
          className="gap-1"
          onLayout={({ nativeEvent: { layout } }) =>
            setRowsBox({ y: layout.y, height: layout.height })
          }
        >
          {rows.map((row, index) => (
            <View
              key={row.key}
              className={`flex-row items-center gap-2 ${row.startsGroup ? "mt-2" : ""}`}
            >
              <Text variant="caption" className="w-1/5">
                {row.label}
              </Text>
              <Animated.View className="flex-1" style={reveal}>
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
                </Svg>
              </Animated.View>
              <Text variant="value" className="w-1/5 text-right">
                {row.current}
              </Text>
            </View>
          ))}
        </View>
        {notice && <Text variant="caption">{notice}</Text>}
      </View>
      {!loading && gapBands.length > 0 && (
        <HeatGapOverlay
          bands={gapBands}
          top={rowsBox.y}
          height={rowsBox.height}
        />
      )}
    </View>
  );
}

/**
 * Sits beside the matrix's image so VoiceOver can reach each gap's note, and
 * over the measured rows so the band spans every row's cell column.
 */
function HeatGapOverlay({
  bands,
  top,
  height,
}: {
  bands: readonly PlacedGapBand[];
  top: number;
  height: number;
}) {
  const { fontScale } = useWindowDimensions();
  const [widthPx, setWidthPx] = useState(0);
  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-0 flex-row gap-2"
      // Measured position of the rows inside the matrix.
      style={{ top, height }}
    >
      <View className="w-1/5" />
      <View
        className="flex-1 overflow-hidden"
        testID="heat-gap-plot"
        onLayout={({ nativeEvent }) => setWidthPx(nativeEvent.layout.width)}
      >
        <GapBands
          bands={bands}
          widthPx={widthPx}
          height={height}
          fontScale={fontScale}
        />
      </View>
      <View className="w-1/5" />
    </View>
  );
}
