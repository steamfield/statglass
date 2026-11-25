import type { NativeStackNavigationOptions } from "expo-router";
import type { ThemeColors } from "./theme-colors";

export function screenOptions(
  _colors: ThemeColors,
  _opts?: { largeTitle?: boolean; root?: boolean }
): NativeStackNavigationOptions {
  return {};
}
