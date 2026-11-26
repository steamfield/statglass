import { View } from "react-native";
import { Button } from "@/ui/button";
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
        tone={error ? "destructive" : undefined}
      >
        {message}
      </Text>
      {onRetry && (
        <Button
          variant="link"
          label="Retry"
          onPress={onRetry}
          className="self-start"
        />
      )}
    </View>
  );
}
