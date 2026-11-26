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
/** Tallest a square cell grows when history returns fewer columns than fit. */
const MAX_CELL_HEIGHT = 16;
/** Space between cells in a row, in points. */
const CELL_GAP = 2;
const ROW_GAP = 8;
const SWATCH_WIDTH = 14;

/** Fixed label and reading columns, in points at the default text size. */
export interface HeatColumns {
  label: number;
  reading: number;
}

/** The side columns at the current Dynamic Type size. */
export function scaled(columns: HeatColumns, fontScale: number): HeatColumns {
  return {
    label: columns.label * fontScale,
    reading: columns.reading * fontScale,
  };
}

/**
 * How many columns of roughly square cells fit a matrix `width` points wide,
 * after the label and reading columns and the gaps between them.
 */
export function squareCellColumns(
  width: number,
  columns: HeatColumns,
  fontScale: number
): number {
  const { label, reading } = scaled(columns, fontScale);
  const plot = width - label - reading - 2 * ROW_GAP;
  return Math.max(1, Math.floor((plot + CELL_GAP) / (CELL_HEIGHT + CELL_GAP)));
}

function sideStyle(width: number | undefined) {
  return width === undefined ? undefined : { width };
}
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
  sides,
}: {
  model: HeatMatrixModel;
  height: number;
  /** Labelled gaps drawn as one band over every row, as on the desktop. */
  gapBands?: readonly PlacedGapBand[];
  /** Fixed label and reading columns; each is a fifth of the width without it. */
  sides?: HeatColumns | undefined;
}) {
  const [rowsBox, setRowsBox] = useState({ y: 0, height: 0 });
  const [plotWidth, setPlotWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const side = sides && scaled(sides, fontScale);
  const sideClass = side ? "" : "w-1/5";
  const scheme = useColorScheme() ?? "light";
  const { cells, rows, columns, legend, loading, notice } = model;
  const reveal = useReveal(loading);
  const fill = resolveColor(
    { kind: "accent", step: 1, ink: false },
    scheme,
    model.accent
  );
  const track = resolveColor({ kind: "token", name: "track" }, scheme);
  const slot = plotWidth / columns;
  // A fixed gap once cells are wide enough to show it; slivers keep a ratio.
  const cellWidth = slot > 3 * CELL_GAP ? slot - CELL_GAP : slot * 0.94;
  // History may merge buckets into fewer columns than were asked for, so with
  // fixed sides the row grows to keep cells square.
  const cellHeight =
    side && plotWidth > 0
      ? Math.min(MAX_CELL_HEIGHT, Math.max(CELL_HEIGHT, cellWidth))
      : CELL_HEIGHT;
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
              <Text
                variant="caption"
                className={sideClass}
                style={sideStyle(side?.label)}
              >
                {row.label}
              </Text>
              <Animated.View
                className="flex-1"
                style={reveal}
                testID={index === 0 ? "heat-plot" : undefined}
                onLayout={
                  index === 0
                    ? ({ nativeEvent }) =>
                        setPlotWidth(nativeEvent.layout.width)
                    : undefined
                }
              >
                <Svg accessible={false} height={cellHeight} width="100%">
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
                          x={col * slot}
                          width={cellWidth}
                          height={cellHeight}
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
              <Text
                variant="value"
                className={`${sideClass} text-right`}
                style={sideStyle(side?.reading)}
              >
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
          side={side}
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
  side,
}: {
  bands: readonly PlacedGapBand[];
  top: number;
  height: number;
  side: HeatColumns | undefined;
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
      <View className={side ? "" : "w-1/5"} style={sideStyle(side?.label)} />
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
      <View className={side ? "" : "w-1/5"} style={sideStyle(side?.reading)} />
    </View>
  );
}
