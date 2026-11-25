import {
  type MirrorBarsData,
  mirrorBarsModel,
} from "@core/widget-models/mirror-bars";
import type { ColorRef } from "@core/widget-models/tokens";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  useAnimatedValue,
  useColorScheme,
  View,
} from "react-native";
import { resolveColor } from "./colors";

// Match the desktop tick and scan until the phone has shared motion tokens.
const BAR_TICK_MS = 150;
const BAR_LOADING_SWEEP_MS = 900;
const LOADING_MARK_WIDTH = 32;

function useReduceMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let awaitingInitial = true;
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (enabled) => {
        awaitingInitial = false;
        setReduced(enabled);
      }
    );
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (awaitingInitial) setReduced(enabled);
    });
    return () => {
      awaitingInitial = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

function useTickOffset({
  endMs,
  intervalMs,
  slotWidth,
  animate,
}: {
  endMs: number | undefined;
  intervalMs: number;
  slotWidth: number;
  animate: boolean;
}) {
  const offset = useAnimatedValue(0);
  const previous = useRef<{ endMs: number | undefined; intervalMs: number }>(
    undefined
  );
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { endMs, intervalMs };
    if (
      !animate ||
      slotWidth <= 0 ||
      endMs === undefined ||
      last?.endMs === undefined ||
      last.intervalMs !== intervalMs
    )
      return;
    if (
      intervalMs <= 0 ||
      Math.abs(endMs - last.endMs - intervalMs) > intervalMs / 2
    )
      return;

    offset.setValue(slotWidth);
    const animation = Animated.timing(offset, {
      toValue: 0,
      duration: BAR_TICK_MS,
      easing: Easing.out(Easing.cubic),
      isInteraction: false,
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      offset.setValue(0);
    };
  }, [animate, endMs, intervalMs, offset, slotWidth]);
  return offset;
}

function LoadingMark({
  width,
  animate,
  color,
}: {
  width: number;
  animate: boolean;
  color: string;
}) {
  const offset = useAnimatedValue(0);
  useEffect(() => {
    if (!animate || width <= 0) return;
    const edge = (width + LOADING_MARK_WIDTH) / 2;
    offset.setValue(-edge);
    const animation = Animated.loop(
      Animated.timing(offset, {
        toValue: edge,
        duration: BAR_LOADING_SWEEP_MS,
        delay: BAR_TICK_MS,
        easing: Easing.linear,
        isInteraction: false,
        useNativeDriver: true,
      })
    );
    animation.start();
    return () => {
      animation.stop();
      offset.setValue(0);
    };
  }, [animate, offset, width]);
  return (
    <Animated.View
      testID="mirror-loading"
      style={{
        width: LOADING_MARK_WIDTH,
        height: "100%",
        backgroundColor: color,
        transform: [{ translateX: offset }],
      }}
    />
  );
}

function BarRow({
  heights,
  slots,
  height,
  color,
  above = false,
}: {
  heights: readonly (number | null)[];
  slots: number;
  height: number;
  color: ColorRef;
  above?: boolean;
}) {
  const backgroundColor = resolveColor(color, useColorScheme() ?? "light");
  // Slot positions stay stable as the window advances.
  const positions = Array.from({ length: slots }, (_, index) => index);
  return (
    <View
      className={
        above ? "flex-row items-end gap-px" : "flex-row items-start gap-px"
      }
      style={{ height }}
    >
      {positions.map((slot) => {
        const barHeight = heights[slot];
        return barHeight == null ? (
          <View key={slot} testID="mirror-gap" className="flex-1" />
        ) : (
          <View
            key={slot}
            testID="mirror-bar"
            className={above ? "flex-1 rounded-t-sm" : "flex-1 rounded-b-sm"}
            style={{ height: barHeight, backgroundColor }}
          />
        );
      })}
    </View>
  );
}

/** Up and down bars mirrored around a stationary baseline. */
export function MirrorBars(data: MirrorBarsData) {
  const { loading, tEndMs, intervalMs, upHeight = 18, downHeight = 30 } = data;
  const { slots, up, down, upColor, downColor, ariaLabel } =
    mirrorBarsModel(data);
  const [width, setWidth] = useState(0);
  const reduced = useReduceMotion();
  const scheme = useColorScheme() ?? "light";
  const offset = useTickOffset({
    endMs: tEndMs,
    intervalMs,
    slotWidth: width / slots,
    animate: !reduced && !loading,
  });
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={ariaLabel}
      accessibilityState={{ busy: !!loading }}
      className="overflow-hidden"
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
    >
      <Animated.View style={{ transform: [{ translateX: offset }] }}>
        <BarRow
          heights={up}
          slots={slots}
          height={upHeight}
          color={upColor}
          above
        />
        <View className="h-px" />
        <BarRow
          heights={down}
          slots={slots}
          height={downHeight}
          color={downColor}
        />
      </Animated.View>
      <View
        className="absolute inset-x-0 h-px items-center overflow-hidden bg-axis"
        style={{ top: upHeight }}
      >
        {loading && (
          <LoadingMark
            width={width}
            animate={!reduced}
            color={resolveColor(downColor, scheme)}
          />
        )}
      </View>
    </View>
  );
}
