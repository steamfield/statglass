/** A heading, optional explanation and Retry action for recoverable failures. */
import { View } from "react-native";
import { Button } from "@/ui/button";
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
      <Button label="Retry" onPress={retry} />
    </View>
  );
}
