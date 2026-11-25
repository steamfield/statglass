/**
 * Shared screen providers for the root layout and component tests. They supply
 * safe-area insets, queries, transport selection, phone settings, theme and motion.
 */
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "expo-router";
import { type PropsWithChildren, type ReactNode, useState } from "react";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  PhoneSettingsProvider,
  type PhoneSettingsProviderProps,
} from "@/data/phone-settings";
import {
  PhoneTransportProvider,
  type PhoneTransportProviderProps,
} from "@/data/transport-context";
import { MotionProvider } from "@/ui/motion";
import { navigationTheme } from "@/ui/navigation-theme";
import { createQueryClient } from "./query-client";

/**
 * Props for {@link Providers}. Without `client`, Providers makes the app's
 * client once and keeps it for its lifetime.
 */
export type ProvidersProps = PropsWithChildren<{ client?: QueryClient }>;

/** Wraps the app in the query client and safe-area providers. */
export function Providers({ children, client }: ProvidersProps) {
  const [ownClient] = useState(createQueryClient);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client ?? ownClient}>
        {children}
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** Shared screen providers for the app and component tests. */
export function AppProviders({
  children,
  client,
  initialTransport,
  initialSettings,
}: {
  children: ReactNode;
  client?: QueryClient;
  initialTransport?: PhoneTransportProviderProps["initial"];
  initialSettings?: PhoneSettingsProviderProps["initial"];
}) {
  const theme = navigationTheme(useColorScheme());
  return (
    <Providers {...(client ? { client } : {})}>
      <PhoneTransportProvider
        {...(initialTransport ? { initial: initialTransport } : {})}
      >
        <PhoneSettingsProvider
          {...(initialSettings ? { initial: initialSettings } : {})}
        >
          <ThemeProvider value={theme}>
            <MotionProvider>{children}</MotionProvider>
          </ThemeProvider>
        </PhoneSettingsProvider>
      </PhoneTransportProvider>
    </Providers>
  );
}
