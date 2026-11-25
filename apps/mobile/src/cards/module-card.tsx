import type { Accent } from "@core/widget-models/tokens";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import type { CardChrome } from "@/cards/types";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";
import { WidgetAccent } from "@/widgets/meter-track";

export const CARD_SURFACE =
  "overflow-hidden rounded-xl border border-border bg-card p-3";
export const CARD_TITLE_ROLE = "cardTitle";
const HEADLINE_ROLE = "cardFigure";
const UNIT_ROLE = "label";

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

/** The module's headline and body open its page as one touch target. */
export function ModuleCard({
  title,
  headline,
  unit,
  spokenHeadline,
  headlineContent,
  spokenDetails,
  accent,
  compact,
  onOpen,
  onLongPress,
  children,
}: CardChrome & {
  title: string;
  headline: string;
  unit?: string | undefined;
  spokenHeadline?: string;
  headlineContent?: ReactNode;
  spokenDetails?: string;
  accent: Accent;
  children: ReactNode;
}) {
  const colors = themeColors[useColorScheme() ?? "light"];
  return (
    <Pressable
      className={`min-h-[44px] min-w-[44px] gap-2 ${CARD_SURFACE}`}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${spokenHeadline ?? (unit ? `${headline} ${unit}` : headline)}`}
      {...(!compact && spokenDetails
        ? { accessibilityValue: { text: spokenDetails } }
        : {})}
      accessibilityActions={[{ name: "menu", label: "Card options" }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "menu") onLongPress();
      }}
      onPress={onOpen}
      onLongPress={onLongPress}
    >
      {({ pressed }) => (
        <>
          <CardGlow accent={accent} pressed={pressed} />
          <View className="flex-row items-center gap-2">
            <View className="flex-1 gap-2">
              <View className="flex-row flex-wrap items-baseline justify-between gap-x-2">
                <Text role={CARD_TITLE_ROLE} className="max-w-full">
                  {title}
                </Text>
                {!headlineContent && (
                  <Text
                    role={HEADLINE_ROLE}
                    className="ml-auto max-w-full text-right"
                    // NativeWind drops the CSS font-variant-numeric property.
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {headline}
                    {unit && <Text role={UNIT_ROLE}> {unit}</Text>}
                  </Text>
                )}
              </View>
              {headlineContent}
            </View>
            <Svg width={12} height={16} viewBox="0 0 12 16" accessible={false}>
              <Path
                d="m4 3 5 5-5 5"
                fill="none"
                stroke={colors["muted-foreground"]}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </View>
          {!compact && <WidgetAccent value={accent}>{children}</WidgetAccent>}
        </>
      )}
    </Pressable>
  );
}
