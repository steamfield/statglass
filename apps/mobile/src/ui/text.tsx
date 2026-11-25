import {
  Text as NativeText,
  type TextProps as NativeTextProps,
  StyleSheet,
} from "react-native";

export type TextVariant =
  | "largeTitle"
  | "title"
  | "onboardingTitle"
  | "cardTitle"
  | "cardFigure"
  | "heroFigure"
  | "body"
  | "label"
  | "value"
  | "caption"
  | "axis";

// RFC 3 defaults at Large. React Native scales these sizes with Dynamic Type.
// 34/600, 22/600, 28/600, 13/600, 15/600 rounded tabular, 28/600 rounded tabular,
// 17/400, 13/400 muted, 13/400 tabular, 12/400 muted, 11/400 muted tabular (max scale 1.5).
const typography = StyleSheet.create({
  largeTitle: { fontSize: 34, fontWeight: "600" },
  title: { fontSize: 22, fontWeight: "600" },
  onboardingTitle: { fontSize: 28, fontWeight: "600" },
  cardTitle: { fontSize: 13, fontWeight: "600" },
  cardFigure: {
    fontSize: 15,
    fontWeight: "600",
    fontFamily: "ui-rounded",
    fontVariant: ["tabular-nums"],
  },
  heroFigure: {
    fontSize: 28,
    fontWeight: "600",
    fontFamily: "ui-rounded",
    fontVariant: ["tabular-nums"],
  },
  body: { fontSize: 17, fontWeight: "400" },
  label: { fontSize: 13, fontWeight: "400" },
  value: { fontSize: 13, fontWeight: "400", fontVariant: ["tabular-nums"] },
  caption: { fontSize: 12, fontWeight: "400" },
  axis: { fontSize: 11, fontWeight: "400", fontVariant: ["tabular-nums"] },
});

/** A theme text colour. Each tone is one token, so light and dark follow the system. */
export type TextTone =
  | "default"
  | "muted"
  | "subtle"
  | "faint"
  | "link"
  | "destructive"
  | "warning"
  | "onPrimary";

export type TextProps = Omit<NativeTextProps, "role"> & {
  variant: TextVariant;
  /** Text colour. Label, caption and axis default to `muted`, every other variant to `default`. */
  tone?: TextTone;
  /** Overrides the variant's weight. */
  weight?: "regular" | "semibold";
  /** Fixed-width digits on a variant that doesn't already have them. */
  tabular?: boolean;
  /** Layout only. Colour, weight and numerals come from the props above. */
  className?: string;
};

export function Text({
  variant,
  // Declared by the phase-1 scaffold; lane 1/a makes them take effect.
  tone: _tone,
  weight: _weight,
  tabular: _tabular,
  className,
  style,
  maxFontSizeMultiplier,
  ...rest
}: TextProps) {
  const heading =
    variant === "largeTitle" ||
    variant === "title" ||
    variant === "onboardingTitle";
  const muted =
    variant === "label" || variant === "caption" || variant === "axis";
  const color = muted ? "text-muted-foreground" : "text-foreground";

  return (
    <NativeText
      accessibilityRole={heading ? "header" : undefined}
      {...rest}
      className={className ? `${color} ${className}` : color}
      maxFontSizeMultiplier={variant === "axis" ? 1.5 : maxFontSizeMultiplier}
      style={[typography[variant], style]}
    />
  );
}
