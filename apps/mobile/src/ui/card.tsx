/** The card surface: rounded, bordered, clipped, on the card colour. */
import type { ReactElement } from "react";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  View,
  type ViewProps,
  type ViewStyle,
} from "react-native";

/** Inner padding: `md` (the default) is 3 spacing units, `lg` is 4, `none` leaves it to the caller. */
export type CardPadding = "none" | "md" | "lg";

/** Native view props with an optional card padding preset. */
export type CardProps = ViewProps & { padding?: CardPadding | undefined };

/**
 * Native pressable props with an optional card padding preset. `style` is a
 * plain style, not a pressed-state callback: NativeWind merges it with the
 * class styles into an array, which `Pressable` cannot call. Pressed feedback
 * comes from the `active:` classes.
 */
export type PressableCardProps = Omit<PressableProps, "role" | "style"> & {
  padding?: CardPadding | undefined;
  style?: StyleProp<ViewStyle> | undefined;
};

const SURFACE = "overflow-hidden rounded-xl border border-border bg-card";
const PADDING = { none: "", md: "p-3", lg: "p-4" };

/** A static card. */
export function Card({
  padding = "md",
  className,
  ...props
}: CardProps): ReactElement {
  const classes = [SURFACE, PADDING[padding], className]
    .filter(Boolean)
    .join(" ");

  return <View {...props} className={classes} />;
}

/**
 * A card that is one control, with a 44 pt minimum size and pressed feedback.
 * It is a button unless the caller gives another `accessibilityRole`.
 */
export function PressableCard({
  padding = "md",
  className,
  ...props
}: PressableCardProps): ReactElement {
  const classes = [
    SURFACE,
    PADDING[padding],
    "min-h-touch min-w-touch active:opacity-70",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Pressable accessibilityRole="button" {...props} className={classes} />
  );
}
