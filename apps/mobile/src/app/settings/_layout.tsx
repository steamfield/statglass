/**
 * The settings stack: the section list and each section's page, under iOS
 * large titles. Wiring only.
 */
import { Stack } from "expo-router";
import { useColorScheme } from "react-native";
import { themeColors } from "@/theme.generated";

/** Stack for the settings sections. */
export default function SettingsLayout() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const colors = themeColors[scheme];
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTintColor: colors.foreground,
        headerUserInterfaceStyle: scheme,
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ title: "Settings" }} />
      <Stack.Screen name="hosts" options={{ title: "Hosts" }} />
      <Stack.Screen name="device" options={{ title: "This iPhone" }} />
      <Stack.Screen name="data" options={{ title: "Data" }} />
      <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
      <Stack.Screen name="about" options={{ title: "About" }} />
    </Stack>
  );
}
