import type { ReactNode } from "react";
import { View } from "react-native";

export function SwipeRow({
  children,
}: {
  children: ReactNode;
  actionLabel: string;
  onAction(): void;
}) {
  return <View>{children}</View>;
}
