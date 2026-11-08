import type { TimeRange } from "@core/brush";
import type { DiskDevice, DiskIoPage } from "@core/generated/bindings";
import { historyKeys, hostKeys, sameDiskIo } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useHostRecord } from "~/hooks/use-host-record";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { useOpenEdge } from "~/hooks/use-range-scope";
import { useRangeQuery } from "~/lib/queries/range";
import { HALF_MINUTE_POLL_MS } from "~/lib/queries/timing";
import { useTransport } from "~/lib/transport-context";
import { useHost, useHostId } from "~/stores/host-store";

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

const NO_DEVICES: readonly DiskDevice[] = [];

/**
 * Device selection and the readable surrounding window. Local inventory belongs
 * to this Mac; remote devices come from capabilities (D-116). Older peers with
 * no inventory use all devices. A fixed end wins over a selection's end; an
 * unpinned window ends at the open bucket edge. Local reads wait for inventory.
 */
export function useDiskIoScope(
  windowMs: number | null,
  fixedEnd: number | null,
  selection: TimeRange | null = null,
  chosen: string | null = null
) {
  const local = useIsLocalHost();
  const host = useHostRecord();
  const inventory = useDiskDevices(local && host !== undefined);
  const remoteDevices = useHost((s) =>
    local ? NO_DEVICES : (s.capabilities?.disk_devices ?? NO_DEVICES)
  );
  const defaultDevice = local
    ? (inventory.data?.default_device ?? null)
    : (remoteDevices.find((d) => d.default)?.dev ??
      remoteDevices[0]?.dev ??
      null);
  const device = selectedDevice(local, chosen, defaultDevice, remoteDevices);
  const edge = useOpenEdge(fixedEnd === null && selection === null);
  const end = fixedEnd ?? selection?.toMs ?? edge;
  const canReadHistory = !local || inventory.data !== undefined;
  const range =
    windowMs !== null && end !== null && canReadHistory
      ? { fromMs: end - windowMs, toMs: end }
      : null;
  return {
    local,
    inventory,
    defaultDevice,
    device,
    range,
    canReadHistory,
    devices: local ? (inventory.data?.devices ?? NO_DEVICES) : remoteDevices,
  };
}

/** Local choices may be disconnected; remote choices must be in capabilities. */
function selectedDevice(
  local: boolean,
  chosen: string | null,
  fallback: string | null,
  remote: readonly DiskDevice[]
) {
  if (chosen === "all") return null;
  if (local) return chosen ?? fallback;
  return remote.some((d) => d.dev === chosen) ? chosen : fallback;
}
