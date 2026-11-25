import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/**
 * Sweeps one segment across the loading baseline until unmount.
 * The delay and duration mirror --motion-fast and --motion-scan on desktop.
 */
export function StreamScan({
  widthPx,
  color,
}: {
  widthPx: number;
  color: string;
}) {
  const segment = widthPx / 5;
  const translateX = useSharedValue(-segment);
  useEffect(() => {
    translateX.set(-segment);
    translateX.set(
      withDelay(
        150,
        withRepeat(
          withTiming(widthPx, {
            duration: 900,
            easing: Easing.linear,
            reduceMotion: ReduceMotion.Never,
          }),
          -1,
          false,
          undefined,
          ReduceMotion.Never
        ),
        ReduceMotion.Never
      )
    );
    return () => cancelAnimation(translateX);
  }, [segment, translateX, widthPx]);
  const motion = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.get() }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      className="absolute bottom-0 left-0 h-px"
      style={[{ width: segment, backgroundColor: color }, motion]}
    />
  );
}
