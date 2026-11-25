import { useLayoutEffect, useRef } from "react";
import {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useMotion } from "@/ui/motion";

/**
 * The desktop's `useReveal` (D-133): when a chart's `loading` goes from true to false,
 * its data layer settles in once, opacity 0 to 1 and height 90% to 100% from
 * `origin` (the baseline, or a mirrored chart's axis), over the enter token. A chart
 * mounted with data does not animate, and with Reduce Motion or Low Power Mode the
 * data simply appears.
 */
export function useReveal(
  loading: boolean | undefined,
  origin: "bottom" | "top" | "center" = "bottom"
) {
  const { enter, easeOut } = useMotion();
  const progress = useSharedValue(1);
  const previous = useRef<boolean | undefined>(undefined);
  useLayoutEffect(() => {
    if (previous.current === true && loading !== true && enter > 0) {
      progress.set(0);
      progress.set(
        withTiming(1, {
          duration: enter,
          easing: Easing.bezier(...easeOut),
          // The motion context already reads Reduce Motion (enter is 0 then).
          reduceMotion: ReduceMotion.Never,
        })
      );
    }
    previous.current = loading;
  }, [loading, enter, easeOut, progress]);
  return useAnimatedStyle(() => {
    const p = progress.get();
    return {
      opacity: p,
      transform: [{ scaleY: 0.9 + 0.1 * p }],
      transformOrigin: origin,
    };
  });
}
