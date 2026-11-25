/**
 * Renders a component under the app's real providers with a fresh query
 * client per test, and optionally a chosen transport and starting settings.
 */
import { render } from "@testing-library/react-native";
import type { ReactElement, ReactNode } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import type { PhoneSettings } from "@/data/phone-settings";
import type { PhoneTransport } from "@/data/seam";
import { AppProviders } from "@/lib/providers";
import { createQueryClient } from "@/lib/query-client";

/**
 * A client with the app's defaults and cache garbage collection off, so no
 * timer outlives the test and keeps jest's worker alive.
 */
function testQueryClient() {
  const client = createQueryClient();
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({
    queries: { ...defaults.queries, gcTime: Number.POSITIVE_INFINITY },
    mutations: { ...defaults.mutations, gcTime: Number.POSITIVE_INFINITY },
  });
  return client;
}

/** What a test can start the app's state from. */
export interface RenderOptions {
  /** The transport the data hooks read; none chosen when absent. */
  transport?: PhoneTransport;
  /** Whether `transport` is the demo (default false). */
  demo?: boolean;
  /** Phone settings to start from instead of the defaults. */
  settings?: Partial<PhoneSettings>;
}

/**
 * Renders `ui` inside the app's providers with a new test client, in the
 * same order as the root layout.
 * @returns the Testing Library render result plus the client it used
 */
export async function renderWithProviders(
  ui: ReactElement,
  { transport, demo = false, settings }: RenderOptions = {}
) {
  const client = testQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <GestureHandlerRootView>
        <AppProviders
          client={client}
          initialTransport={transport ? { transport, demo } : undefined}
          initialSettings={settings}
        >
          {children}
        </AppProviders>
      </GestureHandlerRootView>
    );
  }
  const view = await render(ui, { wrapper: Wrapper });
  return { ...view, client };
}
