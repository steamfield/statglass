import type { TimeRange } from "@core/brush";
import type { DiskIoPage } from "@core/generated/bindings";
import { historyKeys, hostKeys, sameDiskIo } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useRangeQuery } from "~/lib/queries/range";
import { HALF_MINUTE_POLL_MS } from "~/lib/queries/timing";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

export function useDiskDevices(enabled = true) {
  const transport = useTransport();
  const host = useHostId();
  return useQuery({
    queryKey: hostKeys.diskIoDevices(host),
    enabled,
    queryFn: () => unwrap(transport.listDiskIoDevices(host)),
    staleTime: HALF_MINUTE_POLL_MS,
    refetchInterval: HALF_MINUTE_POLL_MS,
  });
}

/**
 * One weighted query for both plots. Never average client-side latency
 * ratios. An answer that reaches the range's end (Rust clips `to_ms` at the
 * host's now) is final; one cut at now reads again every 10 s. `hold` keeps
 * the same device's window on screen while its end moves.
 */
export function useDiskIo(
  device: string | null,
  range: TimeRange | null,
  maxPoints = 120,
  hold = false
) {
  return useRangeQuery<DiskIoPage>(range, {
    key: (hostId, fromMs, toMs) =>
      historyKeys.diskIo(hostId, device, fromMs, toMs, maxPoints),
    fetch: (transport, hostId, fromMs, toMs) =>
      unwrap(
        transport.queryDiskIo({
          host: hostId,
          device,
          from_ms: fromMs,
          to_ms: toMs,
          max_points: maxPoints,
        })
      ),
    isFinal: (d, toMs) => d !== undefined && d.to_ms >= toMs,
    keepPrevious: hold,
    same: sameDiskIo,
  });
}
