import { type CeilingLadder, niceCeiling } from "@core/chart-math";
import {
  type AxisTick,
  timeTicks,
  valueTicks,
} from "@core/chart-math/axis-ticks";
import { eventLabel } from "@core/events";
import { formatHistoryTime, MISSING } from "@core/format";
import type { Event, Gap, Module } from "@core/generated/types";
import { gapBands } from "@core/history-state";
import { hostClock } from "@core/host-clock";
import { DAY_MS } from "@core/time-grid";
import {
  annotationsModel,
  CHART_CAPTION_CHAR_WIDTH_PX,
} from "@core/widget-models/chart-annotation";
import { gapBandsModel } from "@core/widget-models/gap-band";
import type { StreamAreaSeries } from "@core/widget-models/stream-area";
import type { Accent } from "@core/widget-models/tokens";
import { useMemo, useState } from "react";
import {
  Pressable,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import type { HistoryRange } from "@/data/history";
import { Text } from "@/ui/text";
import { ChartAnnotationBand } from "@/widgets/chart-annotations";
import { resolveColor } from "@/widgets/colors";
import { GapBands } from "@/widgets/gap-bands";
import { StreamArea } from "@/widgets/stream-area";
import { useChartScrub } from "./chart-scrub";

// iOS axis text needs wider boxes than the shared caption estimate.
const AXIS_CHAR_SCALE = 1.4;
const AXIS_GAP = 8;
const axisLabelWidth = (label: string, fontScale: number) =>
  label.length * CHART_CAPTION_CHAR_WIDTH_PX * fontScale * AXIS_CHAR_SCALE;

export interface ChartSeries extends StreamAreaSeries {
  label: string;
  /** The measured values behind stacked line geometry. */
  readings?: readonly (number | null)[] | undefined;
}

export type Ceiling = number | { min: number; ladder?: CeilingLadder };

interface ModuleChartProps {
  series: readonly ChartSeries[];
  gaps: readonly Gap[];
  ceiling: Ceiling;
  format(v: number): string;
  range: HistoryRange;
  events: readonly Event[];
  formatEvent?: ((event: Event) => string) | undefined;
  clockOffsetMs: number;
  height: number;
  accent?: Accent;
  module?: Module;
  label?: string;
  /** Shared grid for the series, oldest first. All timestamps use the host clock. */
  grid?: { endMs: number; bucketMs: number } | null;
  loading?: boolean;
  /** Current right edge of the requested window, in host time. */
  nowMs?: number;
}

function ChartLegend({
  series,
  accent,
}: {
  series: readonly ChartSeries[];
  accent: Accent;
}) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  if (series.length < 2) return null;
  return (
    <View className="flex-row flex-wrap gap-3">
      {series.map(({ key, label, step }) => (
        <View key={key} className="flex-row items-center gap-1.5">
          <View
            accessible={false}
            className="size-2 rounded-full"
            style={{
              backgroundColor: resolveColor(
                { kind: "accent", step, ink: true },
                scheme,
                accent
              ),
            }}
          />
          <Text variant="caption">{label}</Text>
        </View>
      ))}
    </View>
  );
}

function TimeAxis({
  ticks,
  width,
  scale,
}: {
  ticks: readonly AxisTick[];
  width: number;
  scale: number;
}) {
  return (
    <View style={{ height: Math.ceil(15 * scale) }}>
      {ticks.map(({ value, frac, label }) => {
        const box = axisLabelWidth(label, scale);
        const left = Math.max(0, Math.min(width - box, frac * width - box / 2));
        return (
          <Text
            key={value}
            variant="axis"
            numberOfLines={1}
            className="absolute"
            style={{
              left,
              width: box,
              textAlign: frac === 0 ? "left" : frac === 1 ? "right" : "center",
            }}
          >
            {label}
          </Text>
        );
      })}
    </View>
  );
}

function ValueAxis({
  ticks,
  height,
  scale,
  width,
}: {
  ticks: readonly AxisTick[];
  height: number;
  scale: number;
  width: number;
}) {
  const lineHeight = Math.ceil(15 * scale);
  return (
    <View style={{ width, height }}>
      {ticks.map(({ value, frac, label }) => (
        <Text
          key={value}
          variant="axis"
          numberOfLines={1}
          className="absolute inset-x-0 text-right"
          style={{ top: (height - lineHeight) * (1 - frac) }}
        >
          {label}
        </Text>
      ))}
    </View>
  );
}

function ChartReadout({
  time,
  values,
  clear,
}: {
  time: string;
  values: readonly { key: string; label: string; figure: string }[];
  clear?: (() => void) | undefined;
}) {
  return (
    <View className="flex-row flex-wrap items-start justify-between gap-2">
      <View className="shrink gap-1">
        <Text variant="caption" className="tabular-nums">
          {time}
        </Text>
        {values.map(({ key, label, figure }) => (
          <Text key={key} variant="value">
            {label} · {figure}
          </Text>
        ))}
      </View>
      {clear && (
        <Pressable
          accessibilityRole="button"
          onPress={clear}
          className="min-h-[44px] min-w-[44px] justify-center active:opacity-70"
        >
          <Text variant="label" className="text-link">
            Clear pin
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function chartFigures(
  series: readonly ChartSeries[],
  slot: number,
  count: number,
  format: ModuleChartProps["format"]
) {
  if (slot < 0) return [];
  return series.map(({ key, label, values, readings = values }) => {
    const value = readings[slot - (count - readings.length)];
    return { key, label, figure: value == null ? MISSING : format(value) };
  });
}

function chartCeiling(
  series: readonly ChartSeries[],
  ceiling: Ceiling
): number {
  if (typeof ceiling === "number") return ceiling;
  const peak = series.reduce(
    (highest, { values }) =>
      values.reduce<number>((max, value) => Math.max(max, value ?? 0), highest),
    0
  );
  return niceCeiling(peak, ceiling.min, ceiling.ladder);
}

function spokenReading(
  time: string | null,
  figures: ReturnType<typeof chartFigures>
) {
  if (time === null) return undefined;
  const values = figures.map(
    ({ label, figure }) =>
      `${label}: ${figure === MISSING ? "No samples" : figure}`
  );
  return { text: [time, ...values].join(", ") };
}

/** Historical plot. Place the shared area grid at its true offset inside the requested span. */
export function ModuleChart({
  series,
  gaps,
  ceiling,
  format,
  range,
  events,
  formatEvent = eventLabel,
  clockOffsetMs,
  height,
  accent = "cpu",
  module,
  label = "History",
  grid,
  loading = false,
  nowMs = Math.floor(hostClock(clockOffsetMs)()),
}: ModuleChartProps) {
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const axisScale = Math.min(1.5, fontScale);
  const { fromMs, toMs } = range;
  const span = toMs - fromMs;
  const count = Math.max(0, ...series.map(({ values }) => values.length));
  const endMs = grid?.endMs ?? toMs;
  const interval = grid?.bucketMs ?? span / Math.max(1, count - 1);
  const firstMs = endMs - Math.max(0, count - 1) * interval;
  const times = useMemo(
    () => Array.from({ length: count }, (_, i) => firstMs + i * interval),
    [count, firstMs, interval]
  );
  const scrub = useChartScrub(times, range, width);
  const yMax = chartCeiling(series, ceiling);
  const yTicks = valueTicks(yMax, format);
  const xTicks = timeTicks(fromMs, toMs, width, {
    clockOffsetMs: 0,
    nowMs,
    captionScale: axisScale * AXIS_CHAR_SCALE,
  });
  const annotations = annotationsModel(
    events.map((event) => ({
      tsMs: event.ts_ms,
      label: formatEvent(event),
      variant: "pill",
    })),
    toMs,
    span,
    width,
    fontScale
  );
  const bands = gapBandsModel(
    gapBands(gaps, fromMs, toMs, {
      ...(module && { module }),
      style: "duration",
    }),
    fromMs,
    toMs
  );
  const time =
    scrub.selection === null
      ? null
      : formatHistoryTime(scrub.selection, span >= DAY_MS);
  const values = chartFigures(series, scrub.slot, count, format);
  const reading = spokenReading(time, values);
  const gridLeft = count === 1 ? firstMs - interval : firstMs;
  const axisWidth = Math.max(
    ...yTicks.map(({ label }) => axisLabelWidth(label, axisScale))
  );
  const drawSeries = !loading && width > 0 && count > 0;
  const showHint = time === null && count > 0;

  return (
    <View className="gap-2">
      <ChartLegend series={series} accent={accent} />
      <View>
        <ChartAnnotationBand
          annotations={annotations}
          widthPx={width}
          fontScale={fontScale}
          inset={axisWidth + AXIS_GAP}
        />
        <View className="flex-row" style={{ gap: AXIS_GAP }}>
          <ValueAxis
            ticks={yTicks}
            height={height}
            scale={axisScale}
            width={axisWidth}
          />
          <View
            className="min-w-0 flex-1"
            onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
            testID="history-chart-plot"
          >
            <View className="relative">
              <GestureDetector gesture={scrub.gesture}>
                <View
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel={label}
                  accessibilityHint="Swipe up or down to read samples. Double tap to pin or clear a reading."
                  accessibilityValue={reading}
                  accessibilityState={{
                    busy: loading,
                    disabled: times.length === 0,
                  }}
                  accessibilityActions={[
                    { name: "increment" },
                    { name: "decrement" },
                    {
                      name: "activate",
                      label: scrub.isPinned ? "Clear pin" : "Pin reading",
                    },
                  ]}
                  onAccessibilityTap={scrub.togglePin}
                  onAccessibilityAction={({ nativeEvent }) =>
                    scrub.handleAction(nativeEvent.actionName)
                  }
                  className="overflow-hidden"
                  style={{ height }}
                >
                  <View
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                  >
                    <StreamArea
                      series={[]}
                      tEndMs={toMs}
                      intervalMs={span}
                      yMax={yMax}
                      accent={accent}
                      height={height}
                      gridlines={yTicks.slice(1).map(({ value }) => value)}
                      loading={loading}
                    />
                    {drawSeries && (
                      <View
                        className="absolute top-0"
                        style={{
                          left: (width * (gridLeft - fromMs)) / span,
                          width:
                            (width * Math.max(1, count - 1) * interval) / span,
                        }}
                      >
                        <StreamArea
                          variant="spark"
                          series={[...series]}
                          tEndMs={endMs}
                          intervalMs={interval}
                          yMax={yMax}
                          accent={accent}
                          height={height}
                        />
                      </View>
                    )}
                  </View>
                  {scrub.slot >= 0 && (
                    <View
                      accessible={false}
                      pointerEvents="none"
                      className="absolute inset-y-0 w-px bg-foreground"
                      style={{
                        left: Math.max(0, Math.min(width - 1, scrub.x)),
                      }}
                    />
                  )}
                </View>
              </GestureDetector>
              <View className="mt-2">
                <TimeAxis ticks={xTicks} width={width} scale={axisScale} />
              </View>
              <GapBands
                bands={bands}
                widthPx={width}
                height={height}
                fontScale={fontScale}
              />
            </View>
          </View>
        </View>
      </View>
      {time && (
        <ChartReadout
          time={time}
          values={values}
          clear={scrub.isPinned ? scrub.clear : undefined}
        />
      )}
      {showHint && (
        <Text variant="caption">Drag to inspect. Touch and hold to pin.</Text>
      )}
    </View>
  );
}
