import { type CeilingState, nextCeiling } from "@core/chart-math";
import { timeTicks, valueTicks } from "@core/chart-math/axis-ticks";
import { eventLabel } from "@core/events";
import { formatHistoryTime, formatRate, MISSING } from "@core/format";
import type { Event, Gap } from "@core/generated/types";
import type { historyGrid } from "@core/history-grid";
import { gapBands } from "@core/history-state";
import { NETWORK_HERO } from "@core/module-hero";
import { DAY_MS, MINUTE_MS } from "@core/time-grid";
import {
  annotationsModel,
  CHART_CAPTION_CHAR_WIDTH_PX,
} from "@core/widget-models/chart-annotation";
import { gapBandsModel } from "@core/widget-models/gap-band";
import { memo, useMemo, useRef, useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import type { HistoryRange } from "@/data/history";
import { useChartScrub } from "@/module/chart-scrub";
import { Text } from "@/ui/text";
import { ChartAnnotationBand } from "@/widgets/chart-annotations";
import { GapBands } from "@/widgets/gap-bands";
import { MirrorBarsPlot } from "@/widgets/mirror-bars";

const { upKey, downKey, upLabel, downLabel, minCeiling } = NETWORK_HERO.chart;
const UP_HEIGHT = 64;
const DOWN_HEIGHT = 96;
const HEIGHT = UP_HEIGHT + DOWN_HEIGHT + 1;
const SUBJECT = "Network history, upload above the line, download below";
const NO_VALUES: readonly (number | null)[] = [];
const captionWidth = CHART_CAPTION_CHAR_WIDTH_PX * 1.4;
const HistoryBars = memo(MirrorBarsPlot);

function NetworkTimeAxis({
  fromMs,
  toMs,
  nowMs,
  width,
  scale,
}: {
  fromMs: number;
  toMs: number;
  nowMs: number;
  width: number;
  scale: number;
}) {
  const ticks = timeTicks(fromMs, toMs, width, {
    clockOffsetMs: 0,
    nowMs,
    captionScale: scale * 1.4,
  });
  return (
    <View style={{ height: Math.ceil(15 * scale) }}>
      {ticks.map(({ value, frac, label }) => {
        const box = captionWidth * label.length * scale;
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

function useRateCeiling(values: readonly (number | null)[], toMs: number) {
  const state = useRef<CeilingState | null>(null);
  const previousPeak = useRef<number | null>(null);
  const peak = useMemo(
    () =>
      values.reduce<number | null>(
        (max, value) =>
          value !== null && (max === null || value > max) ? value : max,
        null
      ),
    [values]
  );
  if (state.current?.lastMs !== toMs || previousPeak.current !== peak) {
    state.current = nextCeiling(state.current, peak, toMs, {
      minCeiling,
      // Rolling history refreshes once a minute; a missed refresh must break the hold.
      maxTickGapMs: 2 * MINUTE_MS,
    });
    previousPeak.current = peak;
  }
  return state.current?.ceiling ?? minCeiling;
}
function DirectionCeiling({
  arrow,
  direction,
  ceiling,
}: {
  arrow: string;
  direction: string;
  ceiling: number;
}) {
  const value = valueTicks(ceiling, formatRate, { count: 2 }).at(-1)?.label;
  return <Text variant="axis">{`${arrow} ${direction} · ${value}`}</Text>;
}

export function NetworkHistoryChart({
  grid,
  range,
  nowMs,
  loading,
  hasSamples,
  gaps,
  events,
}: {
  grid: ReturnType<typeof historyGrid> | null;
  range: HistoryRange;
  nowMs: number;
  loading: boolean;
  hasSamples: boolean;
  gaps: readonly Gap[];
  events: readonly Event[];
}) {
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const { fromMs, toMs } = range;
  const span = toMs - fromMs;
  const up = grid?.values[upKey] ?? NO_VALUES;
  const down = grid?.values[downKey] ?? NO_VALUES;
  const count = Math.max(up.length, down.length);
  const intervalMs = grid?.bucketMs ?? span;
  const firstMs = grid ? grid.endMs - (count - 1) * intervalMs : fromMs;
  const times = useMemo(
    () =>
      hasSamples
        ? Array.from(
            { length: count },
            (_, i) => firstMs + (i + 0.5) * intervalMs
          )
        : [],
    [hasSamples, count, firstMs, intervalMs]
  );
  // Center-based hit testing gives the whole bar one target. If the last
  // center is clipped, extend the scrub domain and width by the same ratio.
  const scrubEnd = Math.max(toMs, times.at(-1) ?? toMs);
  const scrub = useChartScrub(
    times,
    { ...range, toMs: scrubEnd },
    (width * (scrubEnd - fromMs)) / span
  );
  const upMax = useRateCeiling(up, toMs);
  const downMax = useRateCeiling(down, toMs);
  const time =
    scrub.slot < 0
      ? null
      : formatHistoryTime(firstMs + scrub.slot * intervalMs, span >= DAY_MS);
  const upload = formatRate(up[scrub.slot]);
  const download = formatRate(down[scrub.slot]);
  const spokenRate = (rate: string) => (rate === MISSING ? "No samples" : rate);
  const plotInset = (width * (firstMs - fromMs)) / span;
  const plotWidth = count > 0 ? (width * count * intervalMs) / span : width;
  const annotations = annotationsModel(
    events.map((event) => ({
      tsMs: event.ts_ms,
      label: eventLabel(event),
      variant: "pill",
    })),
    toMs,
    span,
    width,
    fontScale
  );
  const bands = gapBandsModel(
    gapBands(gaps, fromMs, toMs, { module: "network", style: "duration" }),
    fromMs,
    toMs
  );
  return (
    <View className="gap-1.5">
      <ChartAnnotationBand
        annotations={annotations}
        widthPx={width}
        fontScale={fontScale}
        inset={0}
      />
      <DirectionCeiling arrow="↑" direction={upLabel} ceiling={upMax} />
      <View
        className="relative"
        testID="history-chart-plot"
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      >
        <GestureDetector gesture={scrub.gesture}>
          <View
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={SUBJECT}
            accessibilityHint={
              hasSamples
                ? "Swipe up or down to read samples. Double tap to pin or clear a reading."
                : undefined
            }
            accessibilityValue={
              time === null
                ? undefined
                : {
                    text: `${time}, ${upLabel} ${spokenRate(upload)}, ${downLabel} ${spokenRate(download)}`,
                  }
            }
            accessibilityState={{ busy: loading, disabled: !hasSamples }}
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
            style={{ height: HEIGHT }}
          >
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="absolute top-0"
              style={{ left: plotInset, width: width > 0 ? plotWidth : "100%" }}
            >
              <HistoryBars
                up={up}
                down={down}
                upMax={upMax}
                downMax={downMax}
                upHeight={UP_HEIGHT}
                downHeight={DOWN_HEIGHT}
                intervalMs={intervalMs}
                accent="net"
                ariaLabel={SUBJECT}
                loading={loading}
              />
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
        <GapBands
          bands={bands}
          widthPx={width}
          height={HEIGHT}
          fontScale={fontScale}
        />
      </View>
      <DirectionCeiling arrow="↓" direction={downLabel} ceiling={downMax} />
      <NetworkTimeAxis
        fromMs={fromMs}
        toMs={toMs}
        nowMs={nowMs}
        width={width}
        scale={Math.min(1.5, fontScale)}
      />
      {time !== null && (
        <View className="flex-row flex-wrap items-start justify-between gap-2">
          <View className="shrink gap-1">
            <Text variant="caption">{time}</Text>
            <Text variant="value">
              {upLabel} · {upload}
            </Text>
            <Text variant="value">
              {downLabel} · {download}
            </Text>
          </View>
          {scrub.isPinned && (
            <Pressable
              accessibilityRole="button"
              onPress={scrub.clear}
              className="min-h-[44px] min-w-[44px] justify-center active:opacity-70"
            >
              <Text variant="label" className="text-link">
                Clear pin
              </Text>
            </Pressable>
          )}
        </View>
      )}
      {time === null && hasSamples && (
        <Text variant="caption">Drag to inspect. Touch and hold to pin.</Text>
      )}
    </View>
  );
}
