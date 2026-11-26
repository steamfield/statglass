/**
 * The History tab's reads of how big this Mac's history is: the bytes on disk
 * now (refreshed every minute while shown) and the growth this Mac measured,
 * which projections are built from. One query each, shared by every panel.
 */
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { MINUTE_POLL_MS } from "~/lib/queries/timing";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

/** Bytes of history on disk for the current host, polled every minute. */
export function useHistorySize() {
  const transport = useTransport();
  const hostId = useHostId();
  return useQuery({
    queryKey: hostKeys.historySize(hostId),
    queryFn: () => unwrap(transport.historySize(hostId)),
    refetchInterval: MINUTE_POLL_MS,
  });
}

/**
 * The current host's measured history growth; `data` is null before an hour
 * is recorded, when projections use the fill-test model.
 */
export function useHistoryGrowth() {
  const transport = useTransport();
  const hostId = useHostId();
  return useQuery({
    queryKey: hostKeys.historyGrowth(hostId),
    queryFn: () => unwrap(transport.historyGrowth(hostId)),
  });
}
