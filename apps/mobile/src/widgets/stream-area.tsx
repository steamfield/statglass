import {
  STREAM_VIEWBOX_W,
  type StreamAreaData,
  type StreamAreaModel,
  streamAreaModel,
} from "@core/widget-models/stream-area";
import { useId, useState } from "react";
import {
  StyleSheet,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Stop,
} from "react-native-svg";
import { themeColors } from "@/theme.generated";
import { useMotion } from "@/ui/motion";
import { Text } from "@/ui/text";
import { useReveal } from "@/widgets/lib/reveal";
import { useTickScroll } from "@/widgets/lib/stream-motion";
import { StreamScan } from "@/widgets/lib/stream-scan";
import { ChartAnnotations } from "./chart-annotations";
import { resolveColor } from "./colors";
import { GapBands } from "./gap-bands";

type Scheme = keyof typeof themeColors;
const CEILING_Y = 1;

/** StreamArea for the phone; takes the same data as the desktop widget. */
export function StreamArea(
  data: StreamAreaData & {
    variant?: "chart" | "spark";
    /** Minimum ceiling-label width, so stacked charts share a left edge. */
    gutterWidth?: number;
    /** Reports the ceiling label's natural width. */
    onGutterMeasure?: (width: number) => void;
  }
) {
  const {
    accent,
    ariaLabel,
    gridlines = [],
    intervalMs,
    loading,
    tEndMs,
    variant = "chart",
    yMax,
    gutterWidth,
    onGutterMeasure,
  } = data;
  const spark = variant === "spark";
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const { fontScale } = useWindowDimensions();
  const [widthPx, setWidth] = useState(0);
  const model = streamAreaModel(data, { widthPx, annotationScale: fontScale });
  const {
    annotations,
    ceilingLabel,
    gaps,
    height,
    series,
    slots,
    windowLabel,
  } = model;
  const { fast, scan, tick } = useMotion();
  const loadingColor = loading
    ? themeColors[scheme][`${accent}-ink`]
    : undefined;
  const scanning = loadingColor && scan > 0 && widthPx > 0;
  const scroll = useTickScroll(
    tEndMs,
    intervalMs,
    widthPx / (slots - 1),
    loading === true,
    tick
  );
  const reveal = useReveal(loading);

  return (
    <View>
      <View className="flex-row gap-1">
        {ceilingLabel && (
          // minWidth is a measured runtime value shared with sibling charts.
          <View style={[styles.ceilingLabel, { minWidth: gutterWidth }]}>
            <Text
              variant="axis"
              onLayout={({ nativeEvent }) =>
                onGutterMeasure?.(nativeEvent.layout.width)
              }
            >
              {ceilingLabel}
            </Text>
          </View>
        )}
        <View className="relative min-w-0 flex-1">
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={ariaLabel}
            accessibilityState={{ busy: loading }}
            className="overflow-hidden"
            style={{ height }}
            onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
          >
            <StreamGrid
              height={height}
              gridlines={spark ? [] : gridlines}
              yMax={yMax}
              scheme={scheme}
              showCeiling={Boolean(ceilingLabel)}
              showBaseline={!spark}
              loadingColor={scanning ? undefined : loadingColor}
            />
            <Animated.View style={scroll}>
              <Animated.View style={reveal}>
                <StreamSeries model={model} accent={accent} scheme={scheme} />
              </Animated.View>
            </Animated.View>
            {scanning && (
              <StreamScan
                widthPx={widthPx}
                color={loadingColor}
                duration={scan}
                delay={fast}
              />
            )}
          </View>
          {gaps.length > 0 && (
            <GapBands
              bands={gaps}
              widthPx={widthPx}
              height={height}
              fontScale={fontScale}
            />
          )}
          {widthPx > 0 && (
            <StreamEdges
              series={series}
              height={height}
              widthPx={widthPx}
              accent={accent}
              scheme={scheme}
            />
          )}
          {annotations.length > 0 && (
            <ChartAnnotations
              annotations={annotations}
              widthPx={widthPx}
              fontScale={fontScale}
            />
          )}
        </View>
      </View>
      {!spark && windowLabel && (
        <Text variant="caption" tone="faint" tabular className="self-end">
          {windowLabel}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ceilingLabel: {
    alignItems: "flex-start",
    alignSelf: "flex-start",
    marginTop: CEILING_Y,
  },
});

function StreamGrid({
  height,
  gridlines,
  yMax,
  scheme,
  showCeiling,
  showBaseline,
  loadingColor,
}: Pick<StreamAreaData, "height" | "yMax"> & {
  gridlines: readonly number[];
  scheme: Scheme;
  showCeiling: boolean;
  showBaseline: boolean;
  loadingColor: string | undefined;
}) {
  const colors = themeColors[scheme];
  const baseline = height - 0.5;
  const scaleMax = yMax > 0 ? yMax : 1;
  return (
    <Svg
      width="100%"
      height={height}
      style={StyleSheet.absoluteFill}
      accessible={false}
    >
      {showCeiling && !gridlines.some((value) => value >= scaleMax) && (
        <Line
          x2="100%"
          y1={CEILING_Y}
          y2={CEILING_Y}
          stroke={colors.grid}
          strokeWidth={1}
        />
      )}
      {gridlines.map((value) => {
        const fraction = Math.max(0, Math.min(1, value / scaleMax));
        const y = height - 1 - fraction * (height - 1 - CEILING_Y);
        return (
          <Line
            key={value}
            x2="100%"
            y1={y}
            y2={y}
            stroke={colors.grid}
            strokeWidth={1}
          />
        );
      })}
      {showBaseline && (
        <Line
          x2="100%"
          y1={baseline}
          y2={baseline}
          stroke={colors.axis}
          strokeWidth={1}
        />
      )}
      {loadingColor && (
        <Line
          x2="25%"
          y1={baseline}
          y2={baseline}
          stroke={loadingColor}
          strokeWidth={1}
        />
      )}
    </Svg>
  );
}

function StreamSeries({
  model: { height, series, dashOffset },
  accent,
  scheme,
}: {
  model: StreamAreaModel;
  accent: StreamAreaData["accent"];
  scheme: Scheme;
}) {
  const id = useId();
  return (
    <Svg
      viewBox={`0 0 ${STREAM_VIEWBOX_W} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
    >
      <Defs>
        {series
          .filter((s) => s.filled)
          .map(({ key, fill }) => {
            const color = resolveColor(fill, scheme, accent);
            // react-native-svg takes gradient stop alpha from stopOpacity.
            const alpha =
              color.length === 9
                ? Number.parseInt(color.slice(-2), 16) / 255
                : 1;
            return (
              <LinearGradient
                key={key}
                id={`${id}-${key}`}
                x1="0%"
                y1="0%"
                x2="0%"
                y2="100%"
              >
                <Stop offset={0} stopColor={color} stopOpacity={0.4 * alpha} />
                <Stop offset={1} stopColor={color} stopOpacity={0} />
              </LinearGradient>
            );
          })}
      </Defs>
      {series.map(
        ({
          key,
          opacity,
          filled,
          linePath,
          areaPath,
          stroke,
          weight,
          dash,
        }) => (
          <G key={key} opacity={opacity}>
            {filled && areaPath && (
              <Path d={areaPath} fill={`url(#${id}-${key})`} />
            )}
            {linePath && (
              <Path
                d={linePath}
                fill="none"
                stroke={resolveColor(stroke, scheme, accent)}
                strokeWidth={weight}
                {...(dash
                  ? { strokeDasharray: dash, strokeDashoffset: dashOffset }
                  : {})}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </G>
        )
      )}
    </Svg>
  );
}

function StreamEdges({
  series,
  height,
  widthPx,
  accent,
  scheme,
}: Pick<StreamAreaModel, "series" | "height"> & {
  widthPx: number;
  accent: StreamAreaData["accent"];
  scheme: Scheme;
}) {
  if (!series.some(({ edges }) => edges.length > 0)) return null;
  // Native SVG clips to its drawable area, including strokes on the boundary.
  const inset = 4;
  return (
    <Svg
      width={Math.ceil(widthPx) + 2 * inset}
      height={Math.ceil(height) + 2 * inset}
      pointerEvents="none"
      accessible={false}
      style={{ position: "absolute", left: -inset, top: -inset }}
    >
      {series.flatMap(({ key, edges, stroke }) => {
        const color = resolveColor(stroke, scheme, accent);
        return edges.map(({ xFrac, y }) => (
          <Circle
            key={`${key}-${xFrac}`}
            cx={inset + xFrac * widthPx}
            cy={inset + y}
            r={2.75}
            fill={themeColors[scheme].card}
            stroke={color}
            strokeWidth={1.5}
          />
        ));
      })}
    </Svg>
  );
}
