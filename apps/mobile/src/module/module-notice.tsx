import { Pressable, View } from "react-native";
import { Text } from "@/ui/text";

export function ModuleNotice({
  message,
  error = false,
  onRetry,
}: {
  message: string;
  error?: boolean;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <View className="gap-1">
      <Text
        variant="label"
        accessibilityLiveRegion="polite"
        accessibilityRole={error ? "alert" : undefined}
        className={error ? "text-destructive" : ""}
      >
        {message}
      </Text>
      {onRetry && (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          className="min-h-[44px] min-w-[44px] justify-center self-start active:opacity-70"
        >
          <Text variant="label" className="text-link">
            Retry
          </Text>
        </Pressable>
      )}
    </View>
  );
}
