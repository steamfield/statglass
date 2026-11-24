/**
 * The app's TanStack Query client and the defaults every query and mutation
 * starts from.
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

/** A client with the app's defaults. Tests make their own per render. */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_DEFAULTS });
}

/** The single production client, shared by every screen. */
export const queryClient = createQueryClient();
