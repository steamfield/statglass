import { useLayoutEffect, useRef } from "react";
import {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { motionEasings } from "@/theme.generated";

const TICK_EASING = Easing.bezier(...motionEasings.easeTick);

/** Slides a consecutive live tick by one slot, resetting across jumps and resizes. */
export function useTickScroll(
  tEndMs: number,
  intervalMs: number,
  slotWidth: number,
  loading: boolean,
  duration: number
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
      duration === 0 ||
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
    translateX.set(
      withTiming(0, {
        duration,
        easing: TICK_EASING,
        reduceMotion: ReduceMotion.Never,
      })
    );
  }, [tEndMs, intervalMs, slotWidth, loading, duration, translateX]);

  return useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.get() }],
  }));
}
