/** Shared state and focused host demand for a module page. */
import type { HostId, HostRecord } from "@core/generated/types";
import type { PhoneRemoteHostStatus } from "@core/phone-connection";
import { useState } from "react";
import { useFocusDemand } from "@/data/demand";
import { useHistoryRange } from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import { useConnection } from "@/data/live";

type Connection = ReturnType<typeof useConnection>;

/** Chart controls and host state common to every module page. */
export interface ModulePage {
  windowMs: number;
  setWindowMs(ms: number): void;
  width: number | null;
  setWidth(width: number): void;
  /** The host's roster record, undefined until the roster loads. */
  record: HostRecord | undefined;
  /** Whether the remote session is connected (true for a host with no remote status). */
  connected: boolean;
  connection: Connection;
  live: boolean;
  range: ReturnType<typeof useHistoryRange>;
}

/** Prepare the page controls and register full demand for the focused host. */
export function useModulePage(
  host: HostId,
  remote: PhoneRemoteHostStatus | undefined,
  defaultRange: number
): ModulePage {
  const [windowMs, setWindowMs] = useState(defaultRange);
  const [width, setWidth] = useState<number | null>(null);
  const record = useHosts().data?.find(({ id }) => id === host);
  const connected = remote === undefined || remote.state === "connected";
  const range = useHistoryRange(windowMs, remote?.clock_offset_ms ?? 0);
  const connection = useConnection(host, remote, null);
  useFocusDemand(host, "full");
  return {
    windowMs,
    setWindowMs,
    width,
    setWidth,
    record,
    connected,
    connection,
    live: connection.state === "live",
    range,
  };
}
