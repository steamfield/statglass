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
import { Text } from "@/ui/text";
import {
  useReduceMotionPreference,
  useTickScroll,
} from "@/widgets/lib/stream-motion";
import { StreamScan } from "@/widgets/lib/stream-scan";
import { ChartAnnotations } from "./chart-annotations";
import { resolveColor } from "./colors";
import { GapBands } from "./gap-bands";

type Scheme = keyof typeof themeColors;

/** StreamArea for the phone; takes the same data as the desktop widget. */
export function StreamArea(data: StreamAreaData) {
  const {
    accent,
    ariaLabel,
    gridlines = [],
    intervalMs,
    loading,
    tEndMs,
    yMax,
  } = data;
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
  const reduceMotion = useReduceMotionPreference();
  const loadingColor = loading
    ? themeColors[scheme][`${accent}-ink`]
    : undefined;
  const scan = loadingColor && !reduceMotion && widthPx > 0;
  const scroll = useTickScroll(
    tEndMs,
    intervalMs,
    widthPx / (slots - 1),
    loading === true,
    reduceMotion
  );

  return (
    <View>
      {ceilingLabel && (
        <Text role="caption" className="text-fg-faint tabular-nums">
          {ceilingLabel}
        </Text>
      )}
      <View className="relative">
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
            gridlines={gridlines}
            yMax={yMax}
            scheme={scheme}
            loadingColor={scan ? undefined : loadingColor}
          />
          <Animated.View style={scroll}>
            <StreamSeries model={model} accent={accent} scheme={scheme} />
          </Animated.View>
          {scan && <StreamScan widthPx={widthPx} color={loadingColor} />}
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
      {windowLabel && (
        <Text role="caption" className="self-end text-fg-faint tabular-nums">
          {windowLabel}
        </Text>
      )}
    </View>
  );
}

function StreamGrid({
  height,
  gridlines,
  yMax,
  scheme,
  loadingColor,
}: Pick<StreamAreaData, "height" | "yMax"> & {
  gridlines: readonly number[];
  scheme: Scheme;
  loadingColor: string | undefined;
}) {
  const colors = themeColors[scheme];
  const baseline = height - 0.5;
  return (
    <Svg
      width="100%"
      height={height}
      style={StyleSheet.absoluteFill}
      accessible={false}
    >
      {gridlines.map((value) => {
        const fraction = Math.max(
          0,
          Math.min(1, value / (yMax > 0 ? yMax : 1))
        );
        const y = height - 1 - fraction * (height - 2);
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
      <Line
        x2="100%"
        y1={baseline}
        y2={baseline}
        stroke={colors.axis}
        strokeWidth={1}
      />
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
