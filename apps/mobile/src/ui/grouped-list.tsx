import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "./text";

export function GroupedList({ children }: { children: ReactNode }) {
  return <View>{children}</View>;
}

export function ListSection({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View>
      {title && <Text variant="body">{title}</Text>}
      {children}
      {footer && <Text variant="body">{footer}</Text>}
    </View>
  );
}
