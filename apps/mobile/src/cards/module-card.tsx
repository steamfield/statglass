import { MISSING } from "@core/format";
import type { Accent } from "@core/widget-models/tokens";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import type { ModuleCardProps } from "@/cards/types";
import { themeColors } from "@/theme.generated";
import { Card } from "@/ui/card";
import { Icon } from "@/ui/icons";
import { Text } from "@/ui/text";
import { WidgetAccent } from "@/widgets/accent";
import { BarSwatch } from "@/widgets/stack-bar";

export const CARD_SURFACE =
  "overflow-hidden rounded-xl border border-border bg-card";
export const CARD_TITLE_ROLE = "cardTitle";

const STATUS_PATHS = {
  info: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 7v4M8 5v.1",
  warning: "M8 1.5 15 14H1L8 1.5ZM8 6v3.5M8 11.5v.1",
  critical: "M5 1.5h6l3.5 3.5v6L11 14.5H5L1.5 11V5L5 1.5ZM8 4.5v4M8 11v.1",
};

/** A decorative status glyph with the explanation supplied as text beside it. */
export function StatusIcon({ kind }: { kind: keyof typeof STATUS_PATHS }) {
  const colors = themeColors[useColorScheme() ?? "light"];
  const color =
    kind === "warning"
      ? colors["warning-ink"]
      : kind === "critical"
        ? colors.destructive
        : colors["muted-foreground"];
  return (
    <Svg
      testID={`status-${kind}`}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      accessible={false}
    >
      <Path
        d={STATUS_PATHS[kind]}
        fill="none"
        stroke={color}
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The popover's upper-left glow drawn over the card surface. */
export function CardGlow({
  accent,
  pressed = false,
}: {
  accent: Accent;
  pressed?: boolean;
}) {
  const color = themeColors[useColorScheme() ?? "light"][accent];
  return (
    // The SVG spans the native surface without taking any layout space.
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      pointerEvents="none"
      accessible={false}
    >
      <Defs>
        <RadialGradient id="card-glow" cx="0%" cy="0%" rx="80%" ry="100%">
          <Stop
            offset={0}
            stopColor={color}
            stopOpacity={pressed ? 0.14 : 0.06}
          />
          <Stop offset={0.6} stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#card-glow)" />
    </Svg>
  );
}

/** The body opens the module, and the header button controls density. */
export function ModuleCard({
  content,
  headline = content.headline ?? MISSING,
  unit,
  spokenHeadline,
  compactDetails = "",
  accent,
  compact,
  accessibilityActions,
  onAccessibilityAction,
  onOpen,
  onToggleDensity,
  children,
}: ModuleCardProps & {
  headline?: string;
  unit?: string | undefined;
  spokenHeadline?: string;
  compactDetails?: string | undefined;
  accent: Accent;
  children: ReactNode;
}) {
  const colors = themeColors[useColorScheme() ?? "light"];
  const { title } = content;
  const spokenDetails = compact ? compactDetails : content.spoken;
  const label = `${title}, ${spokenHeadline ?? (unit ? `${headline} ${unit}` : headline)}`;
  const value = spokenDetails ? { text: spokenDetails } : undefined;
  const customActions =
    accessibilityActions !== undefined && onAccessibilityAction !== undefined;
  const pressableAccessibility = {
    accessible: !customActions,
    accessibilityElementsHidden: customActions,
    importantForAccessibility: customActions
      ? ("no-hide-descendants" as const)
      : ("auto" as const),
  };
  return (
    <Card
      padding="none"
      {...(customActions && {
        accessible: true,
        accessibilityRole: "button" as const,
        accessibilityLabel: label,
        accessibilityValue: value,
        accessibilityActions,
        onAccessibilityAction,
        onAccessibilityTap: onOpen,
      })}
    >
      <Pressable
        {...pressableAccessibility}
        className="min-h-touch gap-1 px-3 pt-3 pb-2"
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={value}
        onPress={onOpen}
      >
        {({ pressed }) => (
          <>
            <CardGlow accent={accent} pressed={pressed} />
            <View className="min-h-5 flex-row flex-wrap items-center justify-between gap-x-2 pr-9">
              <View className="flex-row items-center gap-2">
                <BarSwatch step={1} accent={accent} />
                <Text variant={CARD_TITLE_ROLE} className="shrink">
                  {title}
                </Text>
              </View>
              <Text variant="cardFigure" className="ml-auto shrink text-right">
                {headline}
                {unit && <Text variant="label"> {unit}</Text>}
              </Text>
            </View>
            <WidgetAccent value={accent}>{children}</WidgetAccent>
          </>
        )}
      </Pressable>
      <Pressable
        {...pressableAccessibility}
        accessibilityRole="button"
        accessibilityLabel={`${compact ? "Expand" : "Compact"} ${title} card`}
        accessibilityState={{ expanded: !compact }}
        onPress={onToggleDensity}
        style={styles.densityButton}
      >
        <Icon
          name={compact ? "chevron.down" : "chevron.up"}
          color={colors["muted-foreground"]}
          size={14}
        />
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  // The hit area uses the card padding without adding height to the header.
  densityButton: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
