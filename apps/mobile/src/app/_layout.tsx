/**
 * Root layout: global styles, the app's providers, the app lock, the status
 * bar and the navigation stack. Wiring only; screens own their content.
 */
import "@/global.css";
import { type ErrorBoundaryProps, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DemoLifetime } from "@/data/demo";
import { PairingProvider } from "@/data/pairing-context";
import { AppProviders } from "@/lib/providers";
import { AppLockGate } from "@/lock/app-lock-gate";
import { CoreProvider, NativeCoreBridge } from "@/transport";
import { RouteErrorBoundary } from "@/ui/route-error-boundary";
import { useAnnounceStartupFailure } from "@/ui/startup-failure";

/** Keeps screen recovery inside the root providers and navigation stacks. */
export const unstable_settings = { screenErrorBoundary: RouteErrorBoundary };

/** Last resort for errors that reach the root, outside the app providers. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return (
    <SafeAreaProvider>
      <View className="flex-1 bg-background pt-safe">
        <RouteErrorBoundary {...props} />
      </View>
    </SafeAreaProvider>
  );
}

function StartupFailureAnnouncement() {
  useAnnounceStartupFailure();
  return null;
}

function RootStack() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="pair" options={{ title: "Add a host" }} />
      <Stack.Screen name="demo" options={{ title: "Demo hosts" }} />
      <Stack.Screen name="(hosts)" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="debug" options={{ title: "Debug" }} />
    </Stack>
  );
}

/** Mounts the providers and the app lock around the root stack. */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppProviders>
        <CoreProvider>
          <DemoLifetime />
          <NativeCoreBridge />
          <StatusBar style="auto" />
          <StartupFailureAnnouncement />
          <AppLockGate>
            <PairingProvider>
              <RootStack />
            </PairingProvider>
          </AppLockGate>
        </CoreProvider>
      </AppProviders>
    </GestureHandlerRootView>
  );
}
