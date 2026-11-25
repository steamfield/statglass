/**
 * The defaults every TanStack Query read and write starts from, and the
 * factory for a client that uses them. The root layout makes the app's one
 * client through `Providers`; tests make one per render.
 */
import { commandError } from "@core/command-error";
import { QueryClient } from "@tanstack/react-query";

/**
 * One retry for a failed read unless the phone key is unavailable. Writes get
 * no retries. Returning to the foreground does not refetch.
 */
export const QUERY_DEFAULTS = {
  queries: {
    retry: (failureCount: number, error: unknown) =>
      failureCount < 1 && commandError(error)?.kind !== "phone_key_unavailable",
    refetchOnWindowFocus: false,
  },
  mutations: { retry: false },
} as const;

/** A new client with the app's defaults. */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_DEFAULTS });
}
