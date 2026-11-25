/**
 * The settings stack: the section list and each section's page, under iOS
 * large titles. Wiring only.
 */
import { Stack } from "expo-router";

/** Stack for the settings sections. */
export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerLargeTitle: true }}>
      <Stack.Screen name="index" options={{ title: "Settings" }} />
    </Stack>
  );
}
