/**
 * The alert destinations for the Alerts page's "Send to" panel and the
 * destination dialog: the view read once through TanStack Query and kept
 * current by `alert-destinations-changed`, and the three commands that
 * change or try a destination.
 */
import type {
  AlertDestinationsView,
  DeliveryOutcome,
  Destination,
} from "@core/generated/types";
import { appKeys } from "@core/query-keys";
import type { CommandResult } from "@core/transport";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useTransport } from "~/lib/transport-context";

/** What `useAlertDestinations` returns. */
export interface AlertDestinations {
  /** The destinations and their last deliveries; undefined until read. */
  view: AlertDestinationsView | undefined;
  /** True until the first read settles. */
  isPending: boolean;
  /** Why the read failed, so a failure never reads as "no destinations". */
  error: Error | null;
}

/**
 * The destinations view (`getAlertDestinations`), read on every mount and
 * then replaced by every pushed `alert-destinations-changed` view, so a
 * save in another window or a finished delivery shows without a refetch.
 */
export function useAlertDestinations(): AlertDestinations {
  const transport = useTransport();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: appKeys.alertDestinations,
    queryFn: () => transport.getAlertDestinations(),
    staleTime: Number.POSITIVE_INFINITY,
    // The push listener lives only while mounted, so a cached view may have
    // missed changes; the read is an in-memory command and cheap.
    refetchOnMount: "always",
  });
  useEffect(
    () =>
      transport.onAlertDestinationsChanged((view) =>
        client.setQueryData<AlertDestinationsView>(
          appKeys.alertDestinations,
          view
        )
      ),
    [client, transport]
  );
  return {
    view: query.data,
    isPending: query.isPending,
    error: query.error,
  };
}

/** The destination commands, each answering the command's own result. */
export interface AlertDestinationCommands {
  /** Adds or replaces a destination; a rejection carries Rust's reason. */
  save: (
    destination: Destination
  ) => Promise<CommandResult<AlertDestinationsView>>;
  /** Removes a destination by id. */
  remove: (id: string) => Promise<CommandResult<AlertDestinationsView>>;
  /** Sends a test message to a destination, saved or not. */
  test: (destination: Destination) => Promise<CommandResult<DeliveryOutcome>>;
}

/**
 * `save`, `remove` and `test`, answering the command result so the caller
 * can show a rejection inline. A save or delete that succeeds writes the
 * view it returns into the cache, so the panel is current even before the
 * pushed event arrives. A rejected call (the IPC failed) rejects.
 */
export function useAlertDestinationCommands(): AlertDestinationCommands {
  const transport = useTransport();
  const client = useQueryClient();
  return useMemo(() => {
    const keep = async (
      pending: Promise<CommandResult<AlertDestinationsView>>
    ) => {
      const result = await pending;
      if (result.status === "ok") {
        client.setQueryData<AlertDestinationsView>(
          appKeys.alertDestinations,
          result.data
        );
      }
      return result;
    };
    return {
      save: (destination) => keep(transport.saveAlertDestination(destination)),
      remove: (id) => keep(transport.deleteAlertDestination(id)),
      test: (destination) => transport.testAlertDestination(destination),
    };
  }, [client, transport]);
}
