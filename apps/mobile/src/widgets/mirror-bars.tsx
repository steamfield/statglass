import { networkCard } from "@core/popover/cards";
import {
  type MirrorBarsData,
  mirrorBarsModel,
} from "@core/widget-models/mirror-bars";
import type { ColorRef } from "@core/widget-models/tokens";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  useAnimatedValue,
  useColorScheme,
  View,
} from "react-native";
import { motionEasings } from "@/theme.generated";
import { useMotion } from "@/ui/motion";
import { Text } from "@/ui/text";
import { resolveColor } from "./colors";

const LOADING_MARK_WIDTH = 32;
const TICK_EASING = Easing.bezier(...motionEasings.easeTick);
// The card supplies the direction names even before it has a reading.
const NETWORK_DIRECTIONS = networkCard(
  { rx: null, tx: null, linkRate: null },
  {}
).items;

function useTickOffset({
  endMs,
  intervalMs,
  slotWidth,
  duration,
}: {
  endMs: number | undefined;
  intervalMs: number;
  slotWidth: number;
  duration: number;
}) {
  const offset = useAnimatedValue(0);
  const previous = useRef<{ endMs: number | undefined; intervalMs: number }>(
    undefined
  );
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { endMs, intervalMs };
    if (
      duration === 0 ||
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
      duration,
      easing: TICK_EASING,
      isInteraction: false,
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      offset.setValue(0);
    };
  }, [duration, endMs, intervalMs, offset, slotWidth]);
  return offset;
}

function LoadingMark({
  width,
  duration,
  delay,
  color,
}: {
  width: number;
  duration: number;
  delay: number;
  color: string;
}) {
  const offset = useAnimatedValue(0);
  useEffect(() => {
    if (duration === 0 || width <= 0) return;
    const edge = (width + LOADING_MARK_WIDTH) / 2;
    offset.setValue(-edge);
    const animation = Animated.loop(
      Animated.timing(offset, {
        toValue: edge,
        duration,
        delay,
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
  }, [delay, duration, offset, width]);
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
  gap,
  color,
  above = false,
}: {
  heights: readonly (number | null)[];
  slots: number;
  height: number;
  gap: number;
  color: ColorRef;
  above?: boolean;
}) {
  const scheme = useColorScheme() ?? "light";
  const fill = resolveColor(color, scheme);
  const ink =
    scheme === "light" && color.kind === "accent"
      ? resolveColor({ ...color, ink: true }, scheme)
      : fill;
  // Slot positions stay stable as the window advances.
  const positions = Array.from({ length: slots }, (_, index) => index);
  return (
    <View
      className={above ? "flex-row items-end" : "flex-row items-start"}
      style={{ height, columnGap: gap }}
    >
      {positions.map((slot) => {
        const barHeight = heights[slot];
        return barHeight == null ? (
          <View key={slot} className="flex-1" />
        ) : (
          <View
            key={slot}
            testID="mirror-bar"
            className={above ? "flex-1 rounded-t-sm" : "flex-1 rounded-b-sm"}
            style={{
              height: barHeight,
              backgroundColor: barHeight < 4 ? ink : fill,
            }}
          />
        );
      })}
    </View>
  );
}

/** Up and down bars mirrored around a stationary baseline. */
export function MirrorBars(data: MirrorBarsData) {
  return (
    <View>
      <MirrorBarsPlot {...data} />
      {data.accent === "net" && (
        <View
          className="flex-row flex-wrap justify-between gap-x-2"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {NETWORK_DIRECTIONS.map(({ label }) => (
            <Text key={label} variant="axis">
              {label}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/** The plot shared by the Network card and row sparkbars. */
export function MirrorBarsPlot(data: MirrorBarsData) {
  const { loading, tEndMs, intervalMs, upHeight = 18, downHeight = 30 } = data;
  const { slots, up, down, upColor, downColor, ariaLabel } =
    mirrorBarsModel(data);
  const [width, setWidth] = useState(0);
  const { fast, scan, tick } = useMotion();
  const scheme = useColorScheme() ?? "light";
  const slotWidth = width / slots;
  // Leave room for marks even when the buckets are packed into a narrow row.
  const gap = Math.min(2, slotWidth / 2);
  const offset = useTickOffset({
    endMs: tEndMs,
    intervalMs,
    slotWidth,
    duration: loading ? 0 : tick,
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
          gap={gap}
          color={upColor}
          above
        />
        <View className="h-px" />
        <BarRow
          heights={down}
          slots={slots}
          height={downHeight}
          gap={gap}
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
            duration={scan}
            delay={fast}
            color={resolveColor(downColor, scheme)}
          />
        )}
      </View>
    </View>
  );
}
