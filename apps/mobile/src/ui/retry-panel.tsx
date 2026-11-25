/** A heading, optional explanation and Retry action for recoverable failures. */
import { Pressable, View } from "react-native";
import { Text } from "./text";

/** Presents recovery copy and runs the supplied Retry action. */
export function RetryPanel({
  title,
  detail,
  retry,
}: {
  title: string;
  detail?: string;
  retry(): void;
}) {
  return (
    <View className="gap-4 py-3">
      <View className="gap-1">
        <Text variant="title">{title}</Text>
        {detail && <Text variant="body">{detail}</Text>}
      </View>
      <Pressable
        accessibilityRole="button"
        className="min-h-[44px] items-center justify-center rounded-xl bg-primary px-4 active:opacity-70"
        onPress={retry}
      >
        <Text
          variant="body"
          className="font-semibold! text-primary-foreground!"
        >
          Retry
        </Text>
      </Pressable>
    </View>
  );
}
