import { DarkTheme, DefaultTheme } from "expo-router";
import { colorsForScheme } from "./theme-colors";

function createTheme(base: typeof DefaultTheme) {
  const colors = colorsForScheme(base.dark ? "dark" : "light");
  return {
    ...base,
    colors: {
      background: colors.background,
      border: colors.border,
      card: colors.card,
      notification: colors.destructive,
      primary: colors.foreground,
      text: colors.foreground,
    },
  };
}

const light = createTheme(DefaultTheme);
const dark = createTheme(DarkTheme);

export function navigationTheme(scheme: "light" | "dark" | null | undefined) {
  return scheme === "dark" ? dark : light;
}
