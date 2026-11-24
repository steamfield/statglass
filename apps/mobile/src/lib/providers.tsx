/**
 * The providers every screen runs under: TanStack Query and the safe-area
 * insets. The root layout and the tests mount this same component.
 */
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { queryClient } from "./query-client";

/** Props for {@link Providers}; `client` defaults to the production client. */
export type ProvidersProps = PropsWithChildren<{ client?: QueryClient }>;

/** Wraps the app in the query client and safe-area providers. */
export function Providers({ children, client = queryClient }: ProvidersProps) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </SafeAreaProvider>
  );
}
