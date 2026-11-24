/**
 * Root layout: global styles, the app's providers and the navigation stack.
 * Wiring only; screens own their content.
 */
import "../global.css";
import { Stack } from "expo-router";
import { Providers } from "../lib/providers";

/** Mounts the providers around the root stack. */
export default function RootLayout() {
  return (
    <Providers>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Pair with your Mac" }} />
        <Stack.Screen
          name="pair-linux"
          options={{ title: "Add a Linux server" }}
        />
        <Stack.Screen name="demo" options={{ title: "Demo hosts" }} />
      </Stack>
    </Providers>
  );
}
