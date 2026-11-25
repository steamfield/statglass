import { nearestTime } from "@core/chart-math";
import { formatHistoryTime } from "@core/format";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Pressable, useColorScheme, View } from "react-native";
import {
  GestureDetector,
  useCompetingGestures,
  useLongPressGesture,
  usePanGesture,
} from "react-native-gesture-handler";
import { Text } from "@/ui/text";
import { resolveColor } from "@/widgets/colors";
import { StreamArea } from "@/widgets/stream-area";

interface ScrubbableChartProps {
  chart: StreamAreaData;
  sampleCount: number;
  labels: readonly string[];
  format: (value: number | null) => string;
  showDate: boolean;
}

function ChartLegend({
  series,
  accent,
  labels,
}: Pick<StreamAreaData, "series" | "accent"> & { labels: readonly string[] }) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  if (series.length < 2) return null;
  return (
    <View className="flex-row flex-wrap gap-3">
      {series.map(({ key, step }, index) => (
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
          <Text {...{ role: "caption" }}>{labels[index]}</Text>
        </View>
      ))}
    </View>
  );
}

function useScrubSelection(chart: StreamAreaData, sampleCount: number) {
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const slots = chart.series[0]?.values.length ?? 0;
  const { intervalMs, tEndMs } = chart;
  const times = useMemo(
    () =>
      Array.from(
        { length: sampleCount },
        (_, i) => tEndMs - (slots - 1 - i) * intervalMs
      ),
    [intervalMs, sampleCount, slots, tEndMs]
  );
  const first = times[0] ?? tEndMs;
  const last = times.at(-1) ?? tEndMs;
  const selection =
    cursor !== null && cursor >= first && cursor <= last
      ? nearestTime(times, cursor)
      : null;
  const isPinned = pinned && selection !== null;
  const clear = () => {
    setPinned(false);
    setCursor(null);
  };
  const pin = (time: number) => {
    setCursor(time);
    setPinned(true);
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn("Couldn’t play selection haptic", error);
    });
  };
  const timeAt = (x: number) =>
    width > 0
      ? nearestTime(
          times,
          first + (tEndMs - first) * Math.max(0, Math.min(1, x / width))
        )
      : null;
  const scrub = (x: number) => {
    if (!isPinned) {
      setPinned(false);
      setCursor(timeAt(x));
    }
  };
  const endScrub = () => {
    if (!isPinned) setCursor(null);
  };
  const pinAt = (x: number) => {
    const time = timeAt(x);
    if (time !== null) pin(time);
  };
  const slot = selection === null ? -1 : (selection - first) / intervalMs;
  const togglePin = () => {
    if (isPinned) clear();
    else if (sampleCount > 0) pin(selection ?? last);
  };
  const handleAction = (name: string) => {
    if (name === "activate") return togglePin();
    if (name !== "increment" && name !== "decrement") return;
    const dir = name === "increment" ? 1 : -1;
    const next = slot < 0 ? sampleCount - 1 : slot + dir;
    setCursor(times[Math.max(0, Math.min(sampleCount - 1, next))] ?? null);
  };
  return {
    setWidth,
    selection,
    slot,
    isPinned,
    clear,
    scrub,
    endScrub,
    pinAt,
    togglePin,
    handleAction,
    cursorX: (width * slot) / Math.max(1, slots - 1),
  };
}

/** Draw history with pan scrubbing, long-press pinning and VoiceOver adjustment. */
export function ScrubbableChart({
  chart,
  sampleCount,
  labels,
  format,
  showDate,
}: ScrubbableChartProps) {
  // The twin puts captions outside its plot. Keep them out of the gesture target.
  const { ceilingLabel, ...plot } = chart;
  const {
    setWidth,
    selection,
    slot,
    isPinned,
    clear,
    scrub,
    endScrub,
    pinAt,
    togglePin,
    handleAction,
    cursorX,
  } = useScrubSelection(chart, sampleCount);
  const pan = usePanGesture({
    testID: "history-pan",
    activeOffsetX: [-5, 5],
    failOffsetY: [-10, 10],
    disableReanimated: true,
    onActivate: ({ x }) => scrub(x),
    onUpdate: ({ x }) => scrub(x),
    onDeactivate: endScrub,
  });
  const longPress = useLongPressGesture({
    testID: "history-pin",
    disableReanimated: true,
    onActivate: ({ x }) => pinAt(x),
  });
  const gesture = useCompetingGestures(pan, longPress);
  const time =
    selection === null ? null : formatHistoryTime(selection, showDate);
  const values =
    time === null
      ? []
      : chart.series.map(({ values: samples }, i) => {
          const sample = samples[slot] ?? null;
          const figure = sample === null ? "No samples" : format(sample);
          return chart.series.length > 1 ? `${labels[i]}: ${figure}` : figure;
        });

  return (
    <View className="gap-2">
      <ChartLegend series={plot.series} accent={plot.accent} labels={labels} />
      {ceilingLabel && <Text {...{ role: "caption" }}>{ceilingLabel}</Text>}
      <GestureDetector gesture={gesture}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={chart.ariaLabel}
          accessibilityHint="Swipe up or down to read samples. Double tap to pin or clear a reading."
          accessibilityValue={
            time === null ? undefined : { text: [time, ...values].join(", ") }
          }
          accessibilityActions={[
            { name: "increment" },
            { name: "decrement" },
            { name: "activate", label: isPinned ? "Clear pin" : "Pin reading" },
          ]}
          accessibilityState={{ disabled: sampleCount === 0 }}
          onAccessibilityTap={togglePin}
          onAccessibilityAction={({ nativeEvent: { actionName } }) =>
            handleAction(actionName)
          }
          onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
          style={{ height: chart.height }}
        >
          <StreamArea {...plot} />
          {slot >= 0 && (
            <View
              accessible={false}
              pointerEvents="none"
              className="absolute inset-y-0 w-px bg-foreground"
              style={{ left: cursorX }}
            />
          )}
        </View>
      </GestureDetector>
      {time !== null && (
        <View className="flex-row flex-wrap items-center justify-between gap-x-3">
          <View className="py-1">
            <Text {...{ role: "caption" }} className="tabular-nums">
              {time}
            </Text>
            {values.map((value, index) => (
              <Text
                key={chart.series[index]?.key}
                {...{ role: "body" }}
                className="tabular-nums"
              >
                {value}
              </Text>
            ))}
          </View>
          {isPinned && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear pin"
              onPress={clear}
              className="min-h-[44px] min-w-[44px] justify-center px-2 active:opacity-70"
            >
              <Text {...{ role: "label" }} className="text-link">
                Clear pin
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
