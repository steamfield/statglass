import type { Edition } from "@core/generated/bindings";
import { appKeys } from "@core/query-keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { useTransport } from "~/lib/transport-context";

/**
 * What this build can do (`get_edition`, D-065). It never changes while the
 * app runs, so it is fetched once. `null` until it answers: callers hide
 * an optional action until they know it is there, rather than show it and
 * take it away.
 */
export function useEdition(): Edition | null {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: appKeys.edition,
    queryFn: () => transport.getEdition(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data ?? null;
}

/**
 * `useCanSignal`, but null while the edition is still loading on this Mac.
 * Selection shapes a table (a checkbox column), so a table waits for this
 * instead of adding the column under the reader. A remote host is known at
 * once (false); an edition that fails to load counts as no Quit (false), so
 * nothing waits forever.
 */
export function useCanSignalSettled(): boolean | null {
  const transport = useTransport();
  const local = useIsLocalHost();
  const { data, isPending } = useQuery({
    queryKey: appKeys.edition,
    queryFn: () => transport.getEdition(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!local) return false;
  if (isPending) return null;
  return data?.process_signal === true;
}

/**
 * Whether this view can quit processes: only on this Mac (a remote host's
 * processes are listed, D-117) and only in a build with `process_signal`
 * (the App Store edition has no Quit or Force Quit, D-065).
 */
export function useCanSignal(): boolean {
  const local = useIsLocalHost();
  const edition = useEdition();
  return local && edition?.process_signal === true;
}

/**
 * Records that `process_signal` is not in this build: the command answered
 * `unavailable`, so whatever `get_edition` said, the actions go away.
 */
export function useMarkProcessSignalUnavailable(): () => void {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      queryClient.setQueryData<Edition>(appKeys.edition, (e) => ({
        disk_space: false,
        ...e,
        process_signal: false,
      })),
    [queryClient]
  );
}
