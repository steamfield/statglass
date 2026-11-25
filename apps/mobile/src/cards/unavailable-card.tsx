import { type UiModule, unavailableText } from "@core/module-state";
import type { Accent } from "@core/widget-models/tokens";
import { View } from "react-native";
import {
  CARD_SURFACE,
  CARD_TITLE_ROLE,
  CardGlow,
  StatusIcon,
} from "@/cards/module-card";
import type { UnavailableCardProps } from "@/cards/types";
import { Text } from "@/ui/text";

const MESSAGE_ROLE = "label";

const MODULES: Record<UiModule, readonly [title: string, accent: Accent]> = {
  cpu: ["CPU", "cpu"],
  gpu: ["GPU", "gpu"],
  memory: ["Memory", "mem"],
  power: ["Power & Sensors", "power"],
  network: ["Network", "net"],
  disk: ["Disk", "disk"],
  battery: ["Battery", "battery"],
};

/** An unavailable module stays in the stack with its explanation. */
export function UnavailableCard({ module, state }: UnavailableCardProps) {
  const [title, accent] = MODULES[module];
  return (
    <View className={`gap-2 ${CARD_SURFACE}`}>
      <CardGlow accent={accent} />
      <Text variant={CARD_TITLE_ROLE}>{title}</Text>
      <View className="flex-row items-center gap-1.5">
        <StatusIcon kind="info" />
        <Text variant={MESSAGE_ROLE} className="shrink">
          {unavailableText(state, "host") ?? "Not available"}
        </Text>
      </View>
    </View>
  );
}
