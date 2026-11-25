import { useColorScheme } from "react-native";
import { themeColors } from "@/theme.generated";

export function colorsForScheme(scheme: "light" | "dark" | null | undefined) {
  return themeColors[scheme ?? "light"];
}

export type ThemeColors = ReturnType<typeof colorsForScheme>;

export function useThemeColors() {
  return colorsForScheme(useColorScheme());
}
