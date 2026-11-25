import type { HeatMatrixModel } from "@core/widget-models/heat-matrix";
import { View } from "react-native";
import { Text } from "@/ui/text";

export function HeatMatrix({
  model,
  height,
}: {
  model: HeatMatrixModel;
  height: number;
}) {
  return (
    <View style={{ height }}>
      <Text variant="caption">{model.spoken}</Text>
    </View>
  );
}
