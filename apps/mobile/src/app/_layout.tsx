/**
 * Root layout: global styles, the app's providers, the app lock, the status
 * bar and the navigation stack. Wiring only; screens own their content.
 */
import "@/global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { DemoLifetime } from "@/data/demo";
import { PhoneSettingsProvider } from "@/data/phone-settings";
import { PhoneTransportProvider } from "@/data/transport-context";
import { Providers } from "@/lib/providers";
import { AppLockGate } from "@/lock/app-lock-gate";
import { NativeCoreBridge } from "@/transport";
import { MotionProvider } from "@/ui/motion";

/** Mounts the providers and the app lock around the root stack. */
export default function RootLayout() {
  return (
    <PhoneTransportProvider>
      <PhoneSettingsProvider>
        <Providers>
          <MotionProvider>
            <DemoLifetime />
            <NativeCoreBridge />
            <StatusBar style="auto" />
            <AppLockGate>
              <Stack>
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen
                  name="pair"
                  options={{ title: "Pair with your Mac" }}
                />
                <Stack.Screen
                  name="pair-linux"
                  options={{ title: "Add a Linux server" }}
                />
                <Stack.Screen name="demo" options={{ title: "Demo hosts" }} />
                <Stack.Screen name="(hosts)" options={{ headerShown: false }} />
                <Stack.Screen
                  name="settings"
                  options={{ headerShown: false }}
                />
                <Stack.Screen name="debug" options={{ title: "Debug" }} />
              </Stack>
            </AppLockGate>
          </MotionProvider>
        </Providers>
      </PhoneSettingsProvider>
    </PhoneTransportProvider>
  );
}
