/**
 * TanStack Query client for history and other command-backed data. Adapted
 * from opendata's `app/lib/query.tsx`: same centralised `shouldRetry` /
 * `getRetryDelay` and a stable client held in `useState`. What changed: no
 * SSR or hydration (each Tauri window is its own client), and the errors are
 * `CommandFailure`s from the transport instead of HTTP errors. Live data is
 * never put in this cache.
 */
import { appKeys, diskSpaceKeys, dockerKeys, hostKeys } from "@core/query-keys";
import { CommandFailure } from "@core/transport";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { HISTORY_STALE_MS, QUERY_GC_MS } from "~/lib/queries/timing";
import { useTransport } from "~/lib/transport-context";

/** Command errors that a retry cannot fix. */
const PERMANENT_ERRORS = new Set([
  "unknown_host",
  "history_unavailable",
  "store_corrupt",
  "store_too_new",
  "invalid_argument",
  "invalid_settings",
  // A remote host too old to answer a query (D-117) stays too old.
  "remote_incompatible",
]);

/**
 * Retry decisions live here, not in the transport. Commands are local IPC,
 * so a failure is rarely transient: retry a store error once (a busy
 * writer), never a permanent one.
 */
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof CommandFailure) {
    if (PERMANENT_ERRORS.has(error.error.kind)) return false;
    return failureCount < 1;
  }
  return failureCount < 1;
}

/** Short backoff: 250 ms, then 500 ms. IPC has no thundering herd. */
export function getRetryDelay(attemptIndex: number): number {
  return 250 * 2 ** attemptIndex;
}

/**
 * Families that never retry, whatever the error (v5's `retry` callback never
 * sees the query, so the policy goes by key prefix). Disk space reads and
 * Docker storage and cleanup are polled or re-read on their own; the public
 * address asks an outside service and shows "unavailable" until its next
 * read; the SSH config check and the window appearance answer once.
 */
const NO_RETRY: readonly (readonly unknown[])[] = [
  diskSpaceKeys.all,
  dockerKeys.all,
  appKeys.publicIpAll,
  appKeys.appearance,
  hostKeys.sshConfig(),
];

export function makeQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // History below the last closed bucket does not change; the Timeline
        // appends new buckets itself while following Live.
        staleTime: HISTORY_STALE_MS,
        // Kept only long enough for Back to return to the same rows and scroll
        // position, not the library's 5 minutes: a read is a local IPC call, and
        // ranges left behind are what grew the dashboard's WebContent
        // (plan/rfc-memory-footprint.md, D-127). Queries that cost more opt in.
        gcTime: QUERY_GC_MS,
        // A window regaining focus is not a reason to re-read history.
        refetchOnWindowFocus: false,
        retry: shouldRetry,
        retryDelay: getRetryDelay,
      },
    },
  });
  for (const family of NO_RETRY)
    client.setQueryDefaults(family, { retry: false });
  return client;
}

export function QueryProvider({
  client,
  children,
}: {
  client?: QueryClient;
  children: ReactNode;
}) {
  const transport = useTransport();
  useEffect(() => {
    focusManager.setEventListener((setFocused) => {
      let active = true;
      let receivedEvent = false;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let attempts = 0;
      setFocused(false);
      const unsubscribe = transport.onWindowVisibility((visible) => {
        if (!active) return;
        receivedEvent = true;
        clearTimeout(retry);
        setFocused(visible);
      });
      const readVisibility = () => {
        if (!active || receivedEvent) return;
        void transport.windowVisible().then(
          (visible) => {
            if (active && !receivedEvent) setFocused(visible);
          },
          (error: unknown) => {
            if (!active || receivedEvent) return;
            console.error("[query] reading native window visibility", error);
            retry = setTimeout(
              readVisibility,
              Math.min(getRetryDelay(attempts++), 30000)
            );
          }
        );
      };
      readVisibility();
      return () => {
        active = false;
        clearTimeout(retry);
        unsubscribe();
      };
    });
    return () => {
      focusManager.setEventListener(() => () => {});
      focusManager.setFocused(undefined);
    };
  }, [transport]);
  // One client per window, stable across re-renders.
  const [queryClient] = useState(() => client ?? makeQueryClient());
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
