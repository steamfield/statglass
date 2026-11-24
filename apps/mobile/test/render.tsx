/**
 * Renders a component under the app's real providers with a fresh query
 * client per test.
 */
import { render } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { Providers } from "../src/lib/providers";
import { createQueryClient } from "../src/lib/query-client";

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

/**
 * Renders `ui` inside `Providers` with a new test client.
 * @returns the Testing Library render result plus the client it used
 */
export async function renderWithProviders(ui: ReactElement) {
  const client = testQueryClient();
  const view = await render(<Providers client={client}>{ui}</Providers>);
  return { ...view, client };
}
