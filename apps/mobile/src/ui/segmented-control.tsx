import { useLayoutEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { motionEasings } from "@/theme.generated";
import { useMotion } from "./motion";
import { Text } from "./text";

const THUMB_EASING = Easing.bezier(...motionEasings.easeOut);

export function SegmentedControl<V extends string | number>({
  segments,
  value,
  onChange,
  accessibilityLabel,
}: {
  segments: readonly { value: V; label: string }[];
  value: V;
  onChange(value: V): void;
  accessibilityLabel: string;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const selectedIndex = segments.findIndex(
    (segment) => segment.value === value
  );
  const segmentWidth = segments.length > 0 ? trackWidth / segments.length : 0;

  if (segments.length === 0) return null;

  return (
    <View className="rounded-xl bg-track p-0.5">
      <View
        accessibilityRole="tablist"
        accessibilityLabel={accessibilityLabel}
        className="relative flex-row"
        onLayout={({ nativeEvent }) => setTrackWidth(nativeEvent.layout.width)}
      >
        {selectedIndex >= 0 && segmentWidth > 0 && (
          <SegmentThumb index={selectedIndex} width={segmentWidth} />
        )}
        {segments.map(({ value: segment, label }, index) => {
          const selected = index === selectedIndex;
          return (
            <Pressable
              key={segment}
              accessibilityRole="tab"
              accessibilityLabel={`${label}, ${accessibilityLabel}`}
              accessibilityState={{ selected }}
              className="min-h-touch min-w-touch flex-1 items-center justify-center px-1 py-2 active:opacity-70"
              onPress={() => onChange(segment)}
            >
              <Text
                variant={selected ? "cardTitle" : "label"}
                className="text-center"
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Animated.View takes native positioning so the thumb can move in measured points.
const styles = StyleSheet.create({
  thumb: { position: "absolute", start: 0, top: 0, bottom: 0 },
});

function SegmentThumb({ index, width }: { index: number; width: number }) {
  const { fast } = useMotion();
  const position = useSharedValue(index);
  const previousIndex = useRef(index);

  useLayoutEffect(() => {
    const changed = index !== previousIndex.current;
    previousIndex.current = index;
    position.set(
      changed && fast > 0
        ? withTiming(index, { duration: fast, easing: THUMB_EASING })
        : index
    );
  }, [fast, index, position]);

  const thumbStyle = useAnimatedStyle(() => ({
    width,
    transform: [{ translateX: position.get() * width }],
  }));
  return (
    <Animated.View
      testID="segment-thumb"
      pointerEvents="none"
      style={[styles.thumb, thumbStyle]}
    >
      <View className="flex-1 rounded-[10px] bg-card dark:bg-raised" />
    </Animated.View>
  );
}
