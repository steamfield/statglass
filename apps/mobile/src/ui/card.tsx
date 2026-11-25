/** The card surface: rounded, bordered, clipped, on the card colour. */
import type { ReactElement } from "react";
import type { PressableProps, ViewProps } from "react-native";

/** Inner padding: `md` (the default) is 3 spacing units, `lg` is 4, `none` leaves it to the caller. */
export type CardPadding = "none" | "md" | "lg";

export type CardProps = ViewProps & { padding?: CardPadding };

export type PressableCardProps = PressableProps & { padding?: CardPadding };

/** A static card. */
export function Card(_props: CardProps): ReactElement {
  throw new Error("Card is not implemented");
}

/** A card that is one button, with a 44 pt minimum height and pressed feedback. */
export function PressableCard(_props: PressableCardProps): ReactElement {
  throw new Error("PressableCard is not implemented");
}
