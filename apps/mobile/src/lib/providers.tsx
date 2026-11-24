/**
 * The providers every screen runs under: TanStack Query and the safe-area
 * insets. The root layout and the tests mount this same component.
 */
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type PropsWithChildren, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
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
