import { nearestTime } from "@core/chart-math";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import {
  useCompetingGestures,
  useLongPressGesture,
  usePanGesture,
} from "react-native-gesture-handler";
import type { HistoryRange } from "@/data/history";

export function useChartScrub(
  times: readonly number[],
  range: HistoryRange,
  width: number
) {
  const [cursor, setCursor] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const { fromMs, toMs } = range;
  const spanMs = toMs - fromMs;
  // The host can start the first bucket before the window it overlaps.
  const firstSelectableMs = Math.min(fromMs, times[0] ?? fromMs);
  const selection =
    cursor !== null && cursor >= firstSelectableMs && cursor <= toMs
      ? nearestTime(times, cursor)
      : null;
  const slot = selection === null ? -1 : times.indexOf(selection);
  const isPinned = pinned && slot >= 0;
  const clear = () => {
    setPinned(false);
    setCursor(null);
  };
  const pin = (time: number) => {
    setCursor(time);
    setPinned(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      (error: unknown) => {
        console.warn("Couldn’t play chart pin haptic", error);
      }
    );
  };
  const timeAt = (x: number) =>
    width > 0
      ? nearestTime(
          times,
          fromMs + spanMs * Math.max(0, Math.min(1, x / width))
        )
      : null;
  const scrub = (x: number) => {
    if (!isPinned) {
      setPinned(false);
      setCursor(timeAt(x));
    }
  };
  const pan = usePanGesture({
    testID: "history-pan",
    enabled: times.length > 0,
    activeOffsetX: [-5, 5],
    failOffsetY: [-10, 10],
    disableReanimated: true,
    onActivate: ({ x }) => scrub(x),
    onUpdate: ({ x }) => scrub(x),
    onDeactivate: () => {
      if (!isPinned) setCursor(null);
    },
  });
  const longPress = useLongPressGesture({
    testID: "history-pin",
    enabled: times.length > 0,
    disableReanimated: true,
    onActivate: ({ x }) => {
      const time = timeAt(x);
      if (time !== null) pin(time);
    },
  });
  const gesture = useCompetingGestures(pan, longPress);
  const togglePin = () => {
    if (isPinned) clear();
    else {
      const time = selection ?? times.at(-1);
      if (time !== undefined) pin(time);
    }
  };
  const handleAction = (name: string) => {
    if (name === "activate") return togglePin();
    if (name !== "increment" && name !== "decrement") return;
    const forward = name === "increment";
    const target =
      slot < 0
        ? forward
          ? 0
          : times.length - 1
        : Math.max(0, Math.min(times.length - 1, slot + (forward ? 1 : -1)));
    setCursor(times[target] ?? null);
  };
  return {
    gesture,
    selection,
    slot,
    isPinned,
    clear,
    togglePin,
    handleAction,
    x: selection === null ? 0 : (width * (selection - fromMs)) / spanMs,
  };
}
