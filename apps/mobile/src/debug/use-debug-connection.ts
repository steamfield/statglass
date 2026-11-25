import { commandErrorText } from "@core/command-error";
import type {
  HostId,
  LiveMsg,
  MobileHost,
  RemoteHostStatus,
} from "@core/generated/types";
import { initialHostLive, reduceLive } from "@core/live-state";
import { unwrap } from "@core/transport";
import { useEffect, useState } from "react";
import type { NativeTransport } from "@/transport/native-transport";

// The live catalog and the phone's Hosts screen use this key for total CPU.
const CPU = "cpu.total";

interface DebugReading {
  busy: boolean;
  cpu: number | null;
  remote: RemoteHostStatus | null;
  streamError: string | null;
  statusError: string | null;
}

const initial: DebugReading = {
  busy: false,
  cpu: null,
  remote: null,
  streamError: null,
  statusError: null,
};

function isOffline(remote: RemoteHostStatus | null) {
  return (
    remote !== null &&
    remote.state !== "connecting" &&
    remote.state !== "connected"
  );
}

async function retryOffline(
  transport: NativeTransport,
  host: HostId,
  remote: RemoteHostStatus | null
) {
  if (remote?.state !== "offline" && remote?.state !== "error") return;
  const result = await transport.retryRemoteHost(host);
  // A replacing source may be temporarily absent. Its event reopens the stream.
  if (result.status === "error" && result.error.kind !== "unknown_host") {
    throw result.error;
  }
}

export function useDebugConnection(transport: NativeTransport) {
  const [host, setHost] = useState<MobileHost | null>(null);
  const [reading, setReading] = useState(initial);

  useEffect(() => {
    if (!host) return;
    const id = host.id;
    let active = true;
    let latestStatus = 0;
    let latestStream = 0;
    let stopHosts: (() => void) | undefined;
    let stopStatus: (() => void) | undefined;
    let stopLive: (() => void) | undefined;

    function stop() {
      active = false;
      stopHosts?.();
      stopStatus?.();
      stopLive?.();
    }

    async function refreshStatus() {
      const revision = ++latestStatus;
      try {
        const remotes = await transport.listRemoteHosts();
        if (!active || revision !== latestStatus) return null;
        const remote =
          remotes.find(({ config }) => config.id === id)?.status ?? null;
        setReading((prev) => {
          const lostConnection =
            prev.remote?.state === "connected" && remote?.state !== "connected";
          return {
            ...prev,
            remote,
            cpu: isOffline(remote) || lostConnection ? null : prev.cpu,
            statusError: null,
          };
        });
        return remote;
      } catch (error) {
        if (active && revision === latestStatus) {
          setReading((prev) => ({
            ...prev,
            cpu: null,
            remote: null,
            statusError: commandErrorText(
              error,
              "Couldn’t read connection state."
            ),
          }));
        }
        return null;
      }
    }

    async function openLive() {
      const revision = ++latestStream;
      const current = () => active && revision === latestStream;
      stopLive?.();
      stopLive = undefined;
      let live = initialHostLive(id);
      setReading((prev) => ({ ...prev, cpu: null, streamError: null }));

      function onLive(msg: LiveMsg) {
        if (!current()) return;
        live = reduceLive(live, msg);
        if (msg.kind !== "frame") return;
        const cpu = live.held[CPU] ?? null;
        setReading((prev) =>
          prev.cpu === cpu || isOffline(prev.remote) ? prev : { ...prev, cpu }
        );
      }

      try {
        const sub = await transport.subscribeLive(id, onLive, {
          backfillMs: 0,
          series: [{ metric: CPU, labels: [] }],
        });
        if (!current()) {
          sub.unsubscribe();
          return;
        }
        stopLive = sub.unsubscribe;
        setReading((prev) => ({ ...prev, busy: false }));
      } catch (error) {
        if (!current()) return;
        setReading((prev) => ({
          ...prev,
          busy: false,
          streamError: commandErrorText(
            error,
            "Couldn’t open the live stream."
          ),
        }));
      }
    }

    async function connect(host: MobileHost) {
      await unwrap(transport.setHosts([host]));
      if (!active) return;
      stopStatus = transport.onRemoteHostsChanged(() => void refreshStatus());
      const remote = await refreshStatus();
      if (!active) return;
      await retryOffline(transport, id, remote);
      if (!active) return;
      stopHosts = transport.onHostsChanged(({ hosts }) => {
        if (hosts.some((record) => record.id === id)) void openLive();
      });
      void openLive();
    }

    void connect(host).catch((error: unknown) => {
      if (!active) return;
      stop();
      setReading({
        ...initial,
        streamError: commandErrorText(error, "Couldn’t connect to this Mac."),
      });
    });
    return stop;
  }, [host, transport]);

  return {
    ...reading,
    error: reading.streamError ?? reading.statusError,
    hasAttempt: host !== null,
    connect(next: MobileHost) {
      setReading({ ...initial, busy: true });
      setHost(next);
    },
  };
}
