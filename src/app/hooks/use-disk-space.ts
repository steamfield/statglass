import { commandErrorText } from "@core/command-error";
import type {
  CommandError,
  SpaceHighlight,
  SpaceScanStatus,
} from "@core/generated/types";
import { diskSpaceKeys } from "@core/query-keys";
import { CommandFailure, unwrap } from "@core/transport";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { HALF_MINUTE_POLL_MS } from "~/lib/queries/timing";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

/** How often a running scan is read: progress, and the treemap at most this often. */
export const SPACE_POLL_MS = 1000;

/**
 * The volumes this host can scan, for Disk's links and the Disk space picker.
 * `enabled` is false where the edition has no space reports; the list is
 * fresh for half a minute.
 */
export function useSpaceVolumes(enabled: boolean) {
  const transport = useTransport();
  const host = useHostId();
  return useQuery({
    queryKey: diskSpaceKeys.volumes(host),
    queryFn: () => unwrap(transport.diskSpaceVolumes(host)),
    enabled,
    staleTime: HALF_MINUTE_POLL_MS,
  });
}

/**
 * The running scan, or how the last one ended. Polled only while one runs,
 * and not after a read fails: a scan last seen running on a host that stopped
 * answering is not reported as running. The sidebar keeps this observed on
 * every page, so it is never fresh from the cache: each new observer reads it.
 * When a scan ends, the kept largest-folders summary (D-132) is read again,
 * whichever view started it: a finished boot scan replaces it.
 */
export function useSpaceStatus(enabled: boolean) {
  const transport = useTransport();
  const host = useHostId();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: diskSpaceKeys.status(host),
    queryFn: () => unwrap(transport.diskSpaceStatus(host)),
    enabled,
    staleTime: 0,
    refetchInterval: (q) =>
      q.state.status !== "error" && q.state.data?.phase === "scanning"
        ? SPACE_POLL_MS
        : false,
    refetchOnWindowFocus: false,
  });
  const scanning = currentSpaceStatus(query)?.phase === "scanning";
  const wasScanning = useRef(scanning);
  useEffect(() => {
    // Every mounted observer sees the scan end; the first read is shared, not
    // restarted by the next one.
    if (wasScanning.current && !scanning)
      void client.invalidateQueries(
        { queryKey: diskSpaceKeys.highlights(host) },
        { cancelRefetch: false }
      );
    wasScanning.current = scanning;
  }, [client, host, scanning]);
  return query;
}

/**
 * The status every view acts on: none after a failed read, even though the
 * query still holds the last one it saw, so no view shows a scan as running
 * on a host that stopped answering.
 */
export function currentSpaceStatus(
  query: Pick<ReturnType<typeof useSpaceStatus>, "isError" | "data">
): SpaceScanStatus | undefined {
  return query.isError ? undefined : query.data;
}

/**
 * The kept summary of this host's last boot-volume scan (D-132), or `null`
 * when it has none. `useSpaceStatus` reads it again when a scan ends.
 */
export function useSpaceHighlights() {
  const transport = useTransport();
  const host = useHostId();
  return useQuery({
    queryKey: diskSpaceKeys.highlights(host),
    queryFn: () => unwrap(transport.diskSpaceHighlights(host)),
  });
}

/** The text of a failed space command: its message when it has one. */
export const spaceErrorText = (error: CommandError | unknown) =>
  error instanceof CommandFailure && "message" in error.error
    ? error.error.message
    : String(error);

/** Start and cancel on the host shown, with the error of the last start. */
export function useSpaceScan() {
  const transport = useTransport();
  const host = useHostId();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const start = useCallback(
    async (volume: string, include: readonly string[]) => {
      setStarting(true);
      setError(null);
      try {
        const status = await unwrap(
          transport.diskSpaceStart(host, volume, [...include])
        );
        client.setQueryData<SpaceScanStatus>(
          diskSpaceKeys.status(host),
          status
        );
      } catch (e) {
        setError(spaceErrorText(e));
        await client.invalidateQueries({
          queryKey: diskSpaceKeys.status(host),
        });
      } finally {
        setStarting(false);
      }
    },
    [client, host, transport]
  );
  const cancel = useCallback(async () => {
    const r = await transport.diskSpaceCancel(host);
    if (r.status === "error")
      setError(spaceErrorText(new CommandFailure(r.error)));
    await client.invalidateQueries({ queryKey: diskSpaceKeys.status(host) });
  }, [client, host, transport]);
  return { start, cancel, starting, error };
}

/**
 * Shows a folder from the kept largest-folders summary (D-132) in Finder, and
 * why it couldn't when the reveal fails (the folder was moved or deleted since
 * the scan). The error clears when the next reveal starts.
 */
export function useRevealHighlight() {
  const transport = useTransport();
  const [error, setError] = useState<string | null>(null);
  const reveal = useCallback(
    async (folder: SpaceHighlight) => {
      setError(null);
      try {
        await unwrap(transport.diskSpaceRevealHighlight(folder.path));
      } catch (error) {
        setError(
          commandErrorText(error, "Couldn't show this folder in Finder.")
        );
      }
    },
    [transport]
  );
  return {
    error,
    reveal: (folder: SpaceHighlight) => void reveal(folder),
  };
}
