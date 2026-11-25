/**
 * The defaults every TanStack Query read and write starts from, and the
 * factory for a client that uses them. The root layout makes the app's one
 * client through `Providers`; tests make one per render.
 */
import { commandError } from "@core/command-error";
import { isNativeError } from "@core/native-errors";
import { QueryClient } from "@tanstack/react-query";

/**
 * One retry for internal, busy, unreachable and untyped read failures, none for writes or
 * native-module failures (a locked or missing phone key is not retried), and no
 * refetch when the app comes back to the foreground.
 */
export const QUERY_DEFAULTS = {
  queries: {
    retry(failures: number, error: unknown) {
      if (failures >= 1 || isNativeError(error)) return false;
      const kind = commandError(error)?.kind;
      return (
        kind === undefined ||
        kind === "internal" ||
        kind === "remote_unreachable" ||
        kind === "remote_busy" ||
        kind === "store_busy"
      );
    },
    refetchOnWindowFocus: false,
  },
  mutations: { retry: false },
} as const;

/** A new client with the app's defaults. */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_DEFAULTS });
}
