/** The app's one action button: filled, outlined and text-only forms on a 44 pt target. */
import type { ReactElement } from "react";
import { Pressable } from "react-native";
import { Text } from "@/ui/text";

/** The label, action and presentation options for a button. */
export interface ButtonProps {
  /** Visible text, and the accessible name unless `accessibilityLabel` is given. */
  label: string;
  onPress(): void;
  /** Filled (`primary`, the default), outlined on the card colour, or text only. */
  variant?: "primary" | "secondary" | "link" | undefined;
  disabled?: boolean | undefined;
  /** The action is running: announced as busy, and inert like `disabled`. */
  busy?: boolean | undefined;
  /** Layout classes only: width, margin, self-alignment. */
  className?: string | undefined;
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

const BUTTON_CLASSES = {
  primary:
    "min-h-touch min-w-touch items-center justify-center rounded-xl bg-primary px-4 py-2",
  secondary:
    "min-h-touch min-w-touch items-center justify-center rounded-xl border border-border bg-card px-4 py-2",
  link: "min-h-touch min-w-touch justify-center",
};

/** Renders one pressable action that VoiceOver announces as a button. */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  busy = false,
  className,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ButtonProps): ReactElement {
  const inert = disabled || busy;
  const classes = [
    BUTTON_CLASSES[variant],
    "active:opacity-70",
    inert && "opacity-50",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy }}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      disabled={inert}
      onPress={onPress}
      testID={testID}
      className={classes}
    >
      <ButtonLabel variant={variant} label={label} />
    </Pressable>
  );
}

function ButtonLabel({
  variant,
  label,
}: {
  variant: NonNullable<ButtonProps["variant"]>;
  label: string;
}): ReactElement {
  switch (variant) {
    case "primary":
      return (
        <Text
          variant="body"
          tone="onPrimary"
          weight="semibold"
          className="text-center"
        >
          {label}
        </Text>
      );
    case "secondary":
      return (
        <Text variant="body" className="text-center">
          {label}
        </Text>
      );
    case "link":
      return (
        <Text variant="label" tone="link">
          {label}
        </Text>
      );
  }
}
