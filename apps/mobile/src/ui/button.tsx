/** The app's one action button: filled, outlined and text-only forms on a 44 pt target. */
import type { ReactElement } from "react";

export interface ButtonProps {
  /** Visible text, and the accessible name unless `accessibilityLabel` is given. */
  label: string;
  onPress(): void;
  /** Filled (`primary`, the default), outlined on the card colour, or text only. */
  variant?: "primary" | "secondary" | "link";
  disabled?: boolean;
  /** Layout classes only: width, margin, self-alignment. */
  className?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

/** Renders one pressable action that VoiceOver announces as a button. */
export function Button(_props: ButtonProps): ReactElement {
  throw new Error("Button is not implemented");
}
