import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "./text";

export function Sheet({
  visible,
  title,
  children,
}: {
  visible: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <View>
      {visible && (
        <>
          <Text variant="title">{title}</Text>
          {children}
        </>
      )}
    </View>
  );
}
