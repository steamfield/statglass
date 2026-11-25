import type { ReactNode } from "react";
import type { IconName } from "./icons";
import { Text } from "./text";

export interface ListRowProps {
  title: string;
  subtitle?: string;
  glyph?: IconName;
  value?: string;
  accessory?: "chevron" | "checkmark" | "none";
  selected?: boolean;
  destructive?: boolean;
  onPress?: () => void;
  accessibilityHint?: string;
  trailing?: ReactNode;
}

export function ListRow({ title }: ListRowProps) {
  return <Text variant="body">{title}</Text>;
}
