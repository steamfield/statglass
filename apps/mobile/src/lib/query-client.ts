/**
 * The defaults every TanStack Query read and write starts from, and the
 * factory for a client that uses them. The root layout makes the app's one
 * client through `Providers`; tests make one per render.
 */
import { QueryClient } from "@tanstack/react-query";

/**
 * One retry for a failed read, none for a write, and no refetch when the app
 * comes back to the foreground.
 */
export const QUERY_DEFAULTS = {
  queries: { retry: 1, refetchOnWindowFocus: false },
  mutations: { retry: false },
} as const;

/** A new client with the app's defaults. */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_DEFAULTS });
}
