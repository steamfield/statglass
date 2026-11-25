import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import { View } from "react-native";
import { Text } from "@/ui/text";

export function Sparkbars({
  height,
  accessibilityLabel,
}: {
  data: MirrorBarsData;
  height: number;
  accessibilityLabel: string;
}) {
  return (
    <View style={{ height }}>
      <Text variant="caption">{accessibilityLabel}</Text>
    </View>
  );
}
