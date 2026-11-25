/**
 * Root layout: global styles, the app's providers, the app lock, the status
 * bar and the navigation stack. Wiring only; screens own their content.
 */
import "@/global.css";
import { commandErrorText } from "@core/command-error";
import { nativeErrorText } from "@core/native-errors";
import {
  type ErrorBoundaryProps,
  Stack,
  useGlobalSearchParams,
  usePathname,
} from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DemoLifetime } from "@/data/demo";
import {
  AppProviders,
  useOptionalPhoneTransport,
} from "@/data/transport-context";
import { AppLockGate } from "@/lock/app-lock-gate";
import { CoreProvider, NativeCoreBridge, useNativeCore } from "@/transport";
import { Text } from "@/ui/text";

function RetryPanel({
  title,
  detail,
  retry,
}: {
  title: string;
  detail?: string;
  retry(): void;
}) {
  return (
    <View className="gap-4 px-6 py-3">
      <View accessibilityLiveRegion="polite">
        <Text role="title" accessibilityRole="alert">
          {title}
        </Text>
        {detail && <Text role="body">{detail}</Text>}
      </View>
      <Pressable
        accessibilityRole="button"
        className="min-h-[44px] items-center justify-center rounded-xl bg-primary px-4 active:opacity-70"
        onPress={retry}
      >
        <Text role="body" className="font-semibold text-primary-foreground!">
          Retry
        </Text>
      </Pressable>
    </View>
  );
}

/** Expo Router renders this fallback outside the app's provider tree. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const pathname = usePathname();
  const { host, module, scenario } = useGlobalSearchParams();
  const logged = useRef<Error | null>(null);
  useEffect(() => {
    if (logged.current === error) return;
    logged.current = error;
    console.error("[navigation] screen failed", {
      pathname,
      host,
      module,
      scenario,
      error,
    });
  }, [error, host, module, pathname, scenario]);

  return (
    <SafeAreaProvider>
      <View className="flex-1 justify-center bg-background pt-safe pb-safe">
        <RetryPanel
          title="This screen couldn’t load"
          retry={() => void retry()}
        />
      </View>
    </SafeAreaProvider>
  );
}

function CoreStartNotice() {
  const { error, retry } = useNativeCore();
  const transport = useOptionalPhoneTransport();
  if (!error || transport) return null;
  const copy =
    "source" in error
      ? nativeErrorText(error)
      : { title: "", recovery: commandErrorText(error, "") };
  const detail = copy.recovery || ("source" in error ? error.message : "");
  return (
    <View className="bg-background pt-safe">
      <RetryPanel
        title={copy.title || "StatGlass couldn’t start"}
        detail={detail}
        retry={retry}
      />
    </View>
  );
}

function RootStack() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="pair" options={{ title: "Pair with your Mac" }} />
      <Stack.Screen
        name="pair-linux"
        options={{ title: "Add a Linux server" }}
      />
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
          <AppLockGate>
            <CoreStartNotice />
            <RootStack />
          </AppLockGate>
        </CoreProvider>
      </AppProviders>
    </GestureHandlerRootView>
  );
}
