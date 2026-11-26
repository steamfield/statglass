/**
 * Root layout: global styles, the app's providers, the app lock, the status
 * bar and the navigation stack. Wiring only; screens own their content.
 */
import "@/global.css";
import { type ErrorBoundaryProps, Stack } from "expo-router";
import { useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProviders } from "@/lib/providers";
import { AppLockGate } from "@/lock/app-lock-gate";
import { DemoProvider } from "@/session/demo";
import { PairingProvider } from "@/session/pairing";
import { CoreProvider, NativeCoreBridge } from "@/transport";
import { RouteErrorBoundary } from "@/ui/route-error-boundary";
import { screenOptions } from "@/ui/screen-options";
import { useAnnounceStartupFailure } from "@/ui/startup-failure";
import { useThemeColors } from "@/ui/theme-colors";

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
  const colors = useThemeColors();
  // Subscribe to Dynamic Type changes so mounted headers recompute their options.
  useWindowDimensions();
  const settingsHeader = screenOptions(colors, { largeTitle: true });
  return (
    <Stack screenOptions={screenOptions(colors)}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="pair" options={{ title: "Add a host" }} />
      <Stack.Screen name="demo" options={{ title: "Demo hosts" }} />
      <Stack.Screen name="(hosts)" options={{ headerShown: false }} />
      <Stack.Screen
        name="settings/index"
        options={{ ...settingsHeader, title: "Settings" }}
      />
      <Stack.Screen
        name="settings/hosts"
        options={{ ...settingsHeader, title: "Hosts" }}
      />
      <Stack.Screen
        name="settings/device"
        options={{ ...settingsHeader, title: "This iPhone" }}
      />
      <Stack.Screen
        name="settings/data"
        options={{ ...settingsHeader, title: "Data" }}
      />
      <Stack.Screen
        name="settings/appearance"
        options={{ ...settingsHeader, title: "Appearance" }}
      />
      <Stack.Screen
        name="settings/about"
        options={{ ...settingsHeader, title: "About" }}
      />
      <Stack.Screen
        name="settings/host/[host]"
        options={{ title: "Host details" }}
      />
      <Stack.Screen
        name="update-from-mac"
        options={{ title: "Update from Mac" }}
      />
      <Stack.Screen name="pair-hosts" options={{ title: "Also on this Mac" }} />
      {__DEV__ && <Stack.Screen name="debug" options={{ title: "Debug" }} />}
    </Stack>
  );
}

/** Mounts the providers and the app lock around the root stack. */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppProviders>
        <CoreProvider>
          <DemoProvider>
            <NativeCoreBridge />
            <StartupFailureAnnouncement />
            <AppLockGate>
              <PairingProvider>
                <RootStack />
              </PairingProvider>
            </AppLockGate>
          </DemoProvider>
        </CoreProvider>
      </AppProviders>
    </GestureHandlerRootView>
  );
}
