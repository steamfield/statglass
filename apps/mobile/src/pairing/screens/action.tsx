import { Pressable } from "react-native";
import { Text } from "@/ui/text";

export function PairAction({
  label,
  onPress,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  const surface = secondary ? "border border-border bg-card" : "bg-primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-[44px] items-center justify-center rounded-xl px-4 py-2 active:opacity-70 ${surface} ${disabled ? "opacity-50" : ""}`}
    >
      <Text
        variant="body"
        className={
          secondary
            ? "text-center"
            : "text-center font-semibold! text-primary-foreground!"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}
