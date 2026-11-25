/**
 * The app's text roles, mapped to the iOS text styles they stand for. Sizes
 * are the styles' default (Large) sizes and scale with Dynamic Type, since
 * React Native scales font sizes by the user's text size unless told not to.
 */
import {
  Text as NativeText,
  type TextProps as NativeTextProps,
} from "react-native";

/** Where a piece of text sits in the hierarchy. */
export type TextRole =
  | "largeTitle"
  | "title"
  | "cardTitle"
  | "cardFigure"
  | "body"
  | "label"
  | "caption";

/**
 * Role to classes: the iOS text style's default size and weight, in the
 * theme's foreground colors. Figures use tabular digits so a live value
 * does not shift width every tick.
 */
const ROLE_CLASS: Record<TextRole, string> = {
  // Large Title: 34 pt bold.
  largeTitle: "text-[34px] font-bold text-foreground",
  // Title 2: 22 pt bold.
  title: "text-[22px] font-bold text-foreground",
  // Headline: 17 pt semibold.
  cardTitle: "text-[17px] font-semibold text-foreground",
  // Title 1 figures: 28 pt semibold, tabular.
  cardFigure: "text-[28px] font-semibold text-foreground tabular-nums",
  // Body: 17 pt.
  body: "text-[17px] text-foreground",
  // Subheadline: 15 pt.
  label: "text-[15px] text-muted-foreground",
  // Caption 1: 12 pt.
  caption: "text-[12px] text-muted-foreground",
};

/**
 * Props for {@link Text}: React Native's, with its ARIA `role` replaced by
 * the text role (use `accessibilityRole` for the accessibility role).
 */
export type TextProps = Omit<NativeTextProps, "role"> & { role: TextRole };

/**
 * Text in one of the app's roles. Extra `className` classes follow the
 * role's, so a caller can recolor or align it. Headers announce as headers.
 */
export function Text({ role, className, ...rest }: TextProps) {
  return (
    <NativeText
      accessibilityRole={
        role === "largeTitle" || role === "title" ? "header" : undefined
      }
      {...rest}
      className={
        className ? `${ROLE_CLASS[role]} ${className}` : ROLE_CLASS[role]
      }
    />
  );
}
