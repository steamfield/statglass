import { View } from "react-native";
import { Text } from "./text";

export function SegmentedControl<V extends string | number>(props: {
  segments: readonly { value: V; label: string }[];
  value: V;
  onChange(value: V): void;
  accessibilityLabel: string;
}) {
  return (
    <View
      className="flex-row gap-3"
      accessibilityLabel={props.accessibilityLabel}
    >
      {props.segments.map(({ value, label }) => (
        <Text key={value} variant="body">
          {label}
        </Text>
      ))}
    </View>
  );
}
