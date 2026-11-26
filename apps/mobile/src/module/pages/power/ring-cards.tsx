import {
  RING_GAUGE_DIMENSIONS,
  type RingGaugeInput,
  ringGaugeModel,
} from "@core/widget-models/ring-gauge";
import type { Accent } from "@core/widget-models/tokens";
import type { ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";
import { CardGlow } from "@/cards/module-card";
import { Card } from "@/ui/card";
import { Text } from "@/ui/text";
import { RingGauge } from "@/widgets/ring-gauge";
import { BarSwatch } from "@/widgets/stack-bar";

const RING_SIZE = 88;

export function RingCards({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap justify-between gap-y-2">
      {children}
    </View>
  );
}

export function RingCard({
  title,
  accent,
  ring,
  unit = "",
  detail,
}: {
  title: string;
  accent: Accent;
  ring?: RingGaugeInput;
  unit?: string;
  detail?: string | undefined;
}) {
  const { fontScale } = useWindowDimensions();
  const model = ring && ringGaugeModel(ring, RING_GAUGE_DIMENSIONS[RING_SIZE]);
  return (
    <Card className={`gap-2 ${fontScale >= 1.5 ? "w-full" : "w-[48%]"}`}>
      <CardGlow accent={accent} />
      <View className="flex-row items-center gap-1.5">
        <BarSwatch accent={accent} step={1} />
        <Text variant="cardTitle" className="shrink">
          {title}
        </Text>
      </View>
      {model && (
        <View className="items-center">
          <RingGauge size={RING_SIZE} model={{ ...model, label: unit }} />
        </View>
      )}
      {detail && <Text variant="caption">{detail}</Text>}
    </Card>
  );
}
