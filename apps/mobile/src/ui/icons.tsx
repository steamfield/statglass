import { SymbolView } from "expo-symbols";
import { useThemeColors } from "./theme-colors";

export type IconName =
  | "chevron.left"
  | "chevron.right"
  | "chevron.down"
  | "chevron.up"
  | "gearshape"
  | "xmark"
  | "ellipsis"
  | "checkmark"
  | "line.3.horizontal"
  | "apple.logo"
  | "server.rack"
  | "doc.on.doc";

export function Icon({
  name,
  size = 24,
  color,
  accessibilityLabel,
}: {
  name: IconName;
  size?: number;
  color?: string;
  accessibilityLabel?: string;
}) {
  const colors = useThemeColors();
  return (
    <SymbolView
      name={name}
      size={size}
      weight="regular"
      tintColor={color ?? colors.foreground}
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel === undefined ? undefined : "image"}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
