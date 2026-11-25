import {
  fixed,
  formatBytes,
  formatInteger,
  formatPercent,
  formatRate,
  MISSING,
} from "@core/format";
import type {
  Capabilities,
  HostId,
  ProcessSort,
  ProcessView,
} from "@core/generated/types";
import {
  diskTotal,
  groupLiveProcesses,
  type LiveFigures,
  type LiveGroup,
  netTotal,
} from "@core/process-groups";
import { unwrap } from "@core/transport";
import { useCallback, useMemo, useRef, useState } from "react";
import { useFocusedAppEffect, useHostLive, useHostLiveStream } from "./live";
import { usePhoneTransport } from "./transport-context";

/** A visible live table owns process sampling on its host's current stream. */
export function useProcessDemand(host: HostId, view: ProcessView | null) {
  const transport = usePhoneTransport();
  const stream = useHostLiveStream(host);
  const pending = useRef(Promise.resolve());
  const [failure, setFailure] = useState<{
    stream: number;
    error: unknown;
  } | null>(null);
  useFocusedAppEffect(
    useCallback(() => {
      if (stream === null || view === null) return;
      let active = true;
      const set = (interest: ProcessView | null) => {
        pending.current = pending.current
          .then(() =>
            unwrap(
              transport.setProcessInterest(
                host,
                interest !== null,
                interest,
                stream
              )
            )
          )
          .then(
            () => {
              if (active) setFailure(null);
            },
            (error) => {
              if (active) setFailure({ stream, error });
              console.warn(
                "Could not update live process interest",
                host,
                error
              );
            }
          );
      };
      set(view);
      return () => {
        active = false;
        set(null);
      };
    }, [host, stream, transport, view])
  );
  return failure?.stream === stream ? failure.error : null;
}

export const LIVE_PROCESS_LIMIT = 10;
const decimal = (n: number | null) => (n === null ? MISSING : fixed(n, 1));

export function processColumnAvailable(
  sort: ProcessSort,
  caps: Capabilities | null
) {
  if (caps === null) return true;
  switch (sort) {
    case "gpu":
      return caps.process_gpu === true;
    case "energy":
      return caps.process_energy !== false;
    case "wakeups":
      return caps.process_wakeups !== false;
    case "disk_read":
    case "disk_write":
    case "disk_total":
      return caps.process_disk_io !== false;
    case "net_rx":
    case "net_tx":
    case "net_total":
      return caps.process_network === true;
    default:
      return true;
  }
}

export const PROCESS_COLUMNS: Record<
  ProcessSort,
  {
    label: string;
    value: (figures: LiveFigures) => number | null;
    format: (value: number | null) => string;
  }
> = {
  cpu: { label: "CPU", value: (f) => f.cpu_pct, format: formatPercent },
  memory: { label: "Memory", value: (f) => f.mem_bytes, format: formatBytes },
  gpu: { label: "GPU", value: (f) => f.gpu_pct, format: formatPercent },
  energy: { label: "Energy", value: (f) => f.energy, format: decimal },
  threads: {
    label: "Threads",
    value: (f) => f.threads,
    format: (n) => (n === null ? MISSING : formatInteger(n)),
  },
  wakeups: {
    label: "Wakeups/s",
    value: (f) => f.idle_wakeups_per_s,
    format: decimal,
  },
  disk_read: {
    label: "Read",
    value: (f) => f.disk_read_bps,
    format: formatRate,
  },
  disk_write: {
    label: "Write",
    value: (f) => f.disk_write_bps,
    format: formatRate,
  },
  disk_total: { label: "Disk rate", value: diskTotal, format: formatRate },
  net_rx: { label: "Download", value: (f) => f.net_rx_bps, format: formatRate },
  net_tx: { label: "Upload", value: (f) => f.net_tx_bps, format: formatRate },
  net_total: { label: "Network rate", value: netTotal, format: formatRate },
};

/** Group the current stream's process batch with the desktop's grouping rules. */
export function useLiveProcesses(
  host: HostId,
  sort: ProcessSort
): {
  rows: LiveGroup[] | null;
  available: boolean;
} {
  const stream = useHostLiveStream(host);
  const batch = useHostLive(host, (state) =>
    state.connection === "live" &&
    !state.stale &&
    state.statusSinceMs !== null &&
    state.processes &&
    state.processes.tsMs >= state.statusSinceMs
      ? state.processes.rows
      : null
  );
  return useMemo(() => {
    if (stream === null || batch === null)
      return { rows: null, available: false };
    const { value } = PROCESS_COLUMNS[sort];
    const rows = groupLiveProcesses(batch, "")
      .sort(
        (a, b) =>
          (value(b.figures) ?? -Infinity) - (value(a.figures) ?? -Infinity)
      )
      .slice(0, LIVE_PROCESS_LIMIT);
    return { rows, available: true };
  }, [batch, sort, stream]);
}
