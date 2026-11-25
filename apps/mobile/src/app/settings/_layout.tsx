/**
 * The settings stack: the section list and each section's page, under iOS
 * large titles. Wiring only.
 */
import { Stack } from "expo-router";
import { RouteErrorBoundary } from "@/ui/route-error-boundary";

export const ErrorBoundary = RouteErrorBoundary;
export const unstable_settings = { screenErrorBoundary: ErrorBoundary };

/** Stack for the settings sections. */
export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
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
