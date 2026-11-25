import { Pressable, View } from "react-native";
import { Text } from "./text";

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
        <Text role="title">{title}</Text>
        {detail && <Text role="body">{detail}</Text>}
      </View>
      <Pressable
        accessibilityRole="button"
        className="min-h-[44px] items-center justify-center rounded-xl bg-primary px-4 active:opacity-70"
        onPress={retry}
      >
        <Text role="body" className="font-semibold text-primary-foreground!">
          Retry
        </Text>
      </Pressable>
    </View>
  );
}
