/**
 * A full-width button that opens a route. Three weights: the screen's one
 * primary action, a bordered secondary action and a plain text action.
 */
import { type Href, useRouter } from "expo-router";
import { Pressable, Text } from "react-native";

/** How much visual weight the button carries. */
export type ActionWeight = "primary" | "secondary" | "plain";

const CONTAINER: Record<ActionWeight, string> = {
  primary: "bg-primary",
  secondary: "border border-border bg-card",
  plain: "",
};

const LABEL: Record<ActionWeight, string> = {
  primary: "font-semibold text-primary-foreground",
  secondary: "font-medium text-foreground",
  plain: "font-medium text-link",
};

/** Props for {@link ActionButton}. */
export interface ActionButtonProps {
  label: string;
  href: Href;
  weight: ActionWeight;
}

/**
 * A button that pushes `href`; its visible label is also its accessible name.
 * It is a button rather than a link because it starts a task.
 */
export function ActionButton({ label, href, weight }: ActionButtonProps) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.push(href)}
      // 44 pt is the smallest touch target Apple's guidelines allow.
      className={`min-h-[44px] items-center justify-center rounded-xl px-4 active:opacity-70 ${CONTAINER[weight]}`}
    >
      <Text className={`text-base ${LABEL[weight]}`}>{label}</Text>
    </Pressable>
  );
}
