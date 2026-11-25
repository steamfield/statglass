import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

/** Duration of one live tick slide, matching --motion-tick on desktop. */
export const TICK_DURATION_MS = 150;

const TICK_TIMING = {
  duration: TICK_DURATION_MS,
  easing: Easing.bezier(0.33, 1, 0.68, 1),
  reduceMotion: ReduceMotion.Never,
};

/** Reads Reduce Motion and follows system changes while the app is open. */
export function useReduceMotionPreference() {
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let readPending = true;
    const update = (enabled: boolean) => {
      readPending = false;
      setReduceMotion(enabled);
    };
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      update
    );
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (readPending) update(enabled);
    });
    return () => {
      readPending = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
}

/** Slides a consecutive live tick by one slot, resetting across jumps and resizes. */
export function useTickScroll(
  tEndMs: number,
  intervalMs: number,
  slotWidth: number,
  loading: boolean,
  reduceMotion: boolean
) {
  const translateX = useSharedValue(0);
  const previous = useRef<{
    tEndMs: number;
    intervalMs: number;
    slotWidth: number;
    loading: boolean;
  }>(null);
  useLayoutEffect(() => {
    const prev = previous.current;
    previous.current = { tEndMs, intervalMs, slotWidth, loading };
    if (
      reduceMotion ||
      !prev ||
      loading ||
      prev.loading ||
      intervalMs <= 0 ||
      prev.intervalMs !== intervalMs ||
      slotWidth <= 0 ||
      prev.slotWidth !== slotWidth ||
      Math.abs(tEndMs - prev.tEndMs - intervalMs) > intervalMs / 2
    ) {
      translateX.set(0);
      return;
    }
    translateX.set(slotWidth);
    translateX.set(withTiming(0, TICK_TIMING));
  }, [tEndMs, intervalMs, slotWidth, loading, reduceMotion, translateX]);

  return useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.get() }],
  }));
}
