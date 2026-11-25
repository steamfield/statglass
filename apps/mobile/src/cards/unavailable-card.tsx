import { type UiModule, unavailableText } from "@core/module-state";
import type { Accent } from "@core/widget-models/tokens";
import { Pressable, View, type ViewProps } from "react-native";
import {
  CARD_SURFACE,
  CARD_TITLE_ROLE,
  CardGlow,
  StatusIcon,
} from "@/cards/module-card";
import type { UnavailableCardProps } from "@/cards/types";
import { Text } from "@/ui/text";
import { BarSwatch } from "@/widgets/stack-bar";

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
    <UnavailableCardRow
      title={title}
      accent={accent}
      reason={unavailableText(state, "host") ?? "Not available"}
    />
  );
}

export function UnavailableCardRow({
  title,
  accent,
  reason,
  onOpen,
  accessibilityActions,
  onAccessibilityAction,
}: {
  title: string;
  accent: Accent;
  reason: string;
  onOpen?: () => void;
} & Pick<ViewProps, "accessibilityActions" | "onAccessibilityAction">) {
  const label = `${title}, ${reason}`;
  const className = `flex-row flex-wrap items-center justify-between gap-x-2 p-3 ${CARD_SURFACE}`;
  const row = (
    <>
      <CardGlow accent={accent} />
      <View className="flex-row items-center gap-2">
        <BarSwatch step={1} accent={accent} />
        <Text variant={CARD_TITLE_ROLE}>{title}</Text>
      </View>
      <View className="ml-auto flex-row items-center gap-1.5">
        <StatusIcon kind="info" />
        <Text variant={MESSAGE_ROLE} className="shrink">
          {reason}
        </Text>
      </View>
    </>
  );
  return onOpen ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      className={`min-h-[44px] ${className}`}
      onPress={onOpen}
    >
      {row}
    </Pressable>
  ) : (
    <View accessible accessibilityLabel={label} className={className}>
      {row}
    </View>
  );
}
