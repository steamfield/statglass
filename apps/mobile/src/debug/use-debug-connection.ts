import { commandErrorText } from "@core/command-error";
import type {
  HostId,
  MobileHost,
  RemoteHostStatus,
} from "@core/generated/types";
import type { PhoneRemoteHostRecord } from "@core/phone-connection";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  useOptionalPhoneTransport,
  useSetPhoneTransport,
} from "@/data/transport-context";
import type { NativeTransport } from "@/transport";

async function retryOffline(
  core: NativeTransport,
  host: HostId,
  status: RemoteHostStatus | undefined
) {
  if (status?.state !== "offline" && status?.state !== "error") return;
  const result = await core.retryRemoteHost(host);
  if (result.status === "error" && result.error.kind !== "unknown_host") {
    throw result.error;
  }
}

export function useDebugConnection(core: NativeTransport) {
  const transport = useOptionalPhoneTransport();
  const setTransport = useSetPhoneTransport();
  const client = useQueryClient();
  const [attempt, setAttempt] = useState<{
    host: HostId;
    number: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const wroteHosts = useRef(false);
  const selectedTransport = useRef(false);

  const clearSelection = useEffectEvent(() => {
    if (selectedTransport.current && transport === core)
      setTransport(null, false);
  });

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearSelection();
      if (!wroteHosts.current) return;
      void core.setHosts([]).then((result) => {
        if (result.status === "error") {
          console.warn(
            "[native core] could not clear debug hosts",
            result.error
          );
        }
      });
    };
  }, [core]);

  async function connect(host: MobileHost) {
    if (transport !== null && !selectedTransport.current) {
      setError("Close the current hosts session before connecting from Debug.");
      return;
    }
    setBusy(true);
    setError(null);
    const remotes = client.getQueryData<PhoneRemoteHostRecord[]>(
      hostKeys.remote()
    );
    const status = remotes?.find(({ config }) => config.id === host.id)?.status;
    try {
      wroteHosts.current = true;
      await unwrap(core.setHosts([host]));
      if (!active.current) return;
      await retryOffline(core, host.id, status);
      if (!active.current) return;
      selectedTransport.current = true;
      setTransport(core, false);
      setAttempt((previous) => ({
        host: host.id,
        number: (previous?.number ?? 0) + 1,
      }));
    } catch (failure) {
      if (active.current)
        setError(commandErrorText(failure, "Couldn’t connect to this Mac."));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return { attempt: transport === core ? attempt : null, busy, connect, error };
}
