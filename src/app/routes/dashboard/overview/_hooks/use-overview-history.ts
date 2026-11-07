import { historyKeys } from "@core/query-keys";
import { MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

/** Wake history refreshes every 10 minutes. */
const REFRESH_MS = 10 * MINUTE_MS;

/**
 * When the Mac last woke, from Rust's `last_wake` (its sleep gaps of the
 * last week). Null when there is none in that span, or history is
 * unavailable.
 */
export function useLastWake(): number | null {
  const transport = useTransport();
  const hostId = useHostId();
  const { data } = useQuery({
    queryKey: historyKeys.lastWake(hostId),
    queryFn: () => unwrap(transport.lastWake(hostId)),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
  return data ?? null;
}
