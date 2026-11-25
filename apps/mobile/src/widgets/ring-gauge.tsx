import type { RingGaugeModel } from "@core/widget-models/ring-gauge";
import { View } from "react-native";
import { Text } from "@/ui/text";

export function RingGauge({
  model,
  size,
}: {
  model: RingGaugeModel;
  size: number;
}) {
  return (
    <View style={{ minHeight: size, width: size }}>
      <Text variant="caption">{model.label}</Text>
    </View>
  );
}
