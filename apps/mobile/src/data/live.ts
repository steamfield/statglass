import { formatClock } from "@core/format";
import type { HostId, RemoteHostStatus } from "@core/generated/types";
import { type HostLive, initialHostLive } from "@core/live-state";
import { hostKeys } from "@core/query-keys";
import { failureReason, remoteQueryText } from "@core/remote-errors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useStore } from "zustand";
import { shallow } from "zustand/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import { subscribeHostLive } from "./live-subscription";
import type { PhoneTransport } from "./seam";
import { usePhoneTransport } from "./transport-context";

/** Held host data and the phone's connection state. */
export interface PhoneLive extends HostLive {
  /** Monotonic receipt time. Backfill alone does not make a frame fresh. */
  lastFrame: number | null;
  failure: string | null;
}

/** The store for one host on one transport. */
export type LiveStore = StoreApi<PhoneLive>;
const stores = new WeakMap<PhoneTransport, Map<HostId, LiveStore>>();
function hostStore(transport: PhoneTransport, host: HostId): LiveStore {
  let hosts = stores.get(transport);
  if (!hosts) {
    hosts = new Map();
    stores.set(transport, hosts);
  }
  let store = hosts.get(host);
  if (!store) {
    store = createStore<PhoneLive>(() => ({
      ...initialHostLive(host),
      lastFrame: null,
      failure: null,
    }));
    hosts.set(host, store);
  }
  return store;
}

const appIsActive = () => AppState.currentState === "active";

/** Check foreground activity from the first render and when AppState changes. */
export function useAppActive() {
  const [active, setActive] = useState(appIsActive);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });
    setActive(appIsActive());
    return () => listener.remove();
  }, []);
  return active;
}

/** Run a screen's live work only while it is focused and foregrounded. */
export function useFocusedAppEffect(start: () => (() => void) | undefined) {
  const active = useAppActive();
  useFocusEffect(
    useCallback(() => (active ? start() : undefined), [active, start])
  );
}

/** Only the focused host page owns a live subscription. */
export function useHostLiveSubscription(host: HostId) {
  const transport = usePhoneTransport();
  useFocusedAppEffect(
    useCallback(
      () => subscribeHostLive(hostStore(transport, host), transport, host),
      [host, transport]
    )
  );
}

function useLiveSelection<T>(
  host: HostId,
  select: (state: PhoneLive) => T,
  equal: (a: T, b: T) => boolean = Object.is
): T {
  const transport = usePhoneTransport();
  const selected = useRef<{ value: T } | null>(null);
  const getSelection = useMemo(() => {
    let cached: { state: PhoneLive; value: T } | undefined;
    return (state: PhoneLive) => {
      if (cached?.state === state) return cached.value;
      const value = select(state);
      if (!selected.current || !equal(selected.current.value, value))
        selected.current = { value };
      cached = { state, value: selected.current.value };
      return cached.value;
    };
  }, [select, equal]);
  return useStore(hostStore(transport, host), getSelection);
}

/** Subscribe to just the selected part of a host's held live state. */
export function useHostLive<T>(
  host: HostId,
  select: (state: HostLive) => T,
  equal?: (a: T, b: T) => boolean
): T {
  return useLiveSelection(host, select, equal);
}

/** The phone's monotonic receipt time for the last frame, or null before one arrives. */
export function useLastFrame(host: HostId) {
  return useLiveSelection(host, (state) => state.lastFrame);
}

/** The terminal failure message for the host's live subscription, if one failed. */
export function useLiveFailure(host: HostId) {
  return useLiveSelection(host, (state) => state.failure);
}

/** Label an offline remote with its last-seen time when the status supplies one. */
export function offlineLabel(remote: RemoteHostStatus | undefined) {
  if (!remote || !["offline", "error", "disabled"].includes(remote.state))
    return null;
  return remote.last_seen_ms === null
    ? "Offline"
    : `Offline since ${formatClock(remote.last_seen_ms)}`;
}

/** Connection state shared by the pill and the module's current readings. */
export function useConnection(
  host: HostId,
  remote: RemoteHostStatus | undefined,
  statusError: string | null
) {
  const { connection, stale, paused, idle } = useHostLive(
    host,
    (s) => ({
      connection: s.connection,
      stale: s.stale,
      paused: s.status?.paused,
      idle: s.status?.display_idle,
    }),
    shallow
  );
  const failure = useLiveFailure(host);
  const offline = statusError ?? failure ?? offlineLabel(remote);

  if (offline) return { state: "offline", label: offline } as const;
  if (remote?.state === "connecting") {
    return { state: "reconnecting", label: "Reconnecting" } as const;
  }
  if (paused || idle) {
    return {
      state: "waiting",
      label: paused ? "Paused" : "Display asleep",
    } as const;
  }
  if (stale || connection === "reconnecting") {
    return { state: "reconnecting", label: "Reconnecting" } as const;
  }
  if (connection !== "live")
    return { state: "waiting", label: "Connecting" } as const;
  const route =
    remote?.route === "lan"
      ? "LAN"
      : remote?.route === "tailscale"
        ? "Tailscale"
        : null;
  return { state: "live", label: "Live", route } as const;
}

/** Read one host's remote status and refresh the shared list when it changes. */
export function useRemoteStatus(host: HostId, enabled = true) {
  const transport = usePhoneTransport();
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return transport.onRemoteHostsChanged(() => {
      void client.invalidateQueries({ queryKey: hostKeys.remote() });
    });
  }, [client, enabled, transport]);
  return useQuery({
    queryKey: hostKeys.remote(),
    queryFn: () => transport.listRemoteHosts(),
    select: (hosts) => hosts.find((entry) => entry.config.id === host)?.status,
    enabled,
  });
}

/** Explain a failed connection-status read using the shared remote error wording. */
export function connectionStatusError(error: unknown) {
  return (
    remoteQueryText(error, "connection status") ??
    `Couldn’t read connection status. ${failureReason(error, "Please try again.")}`
  );
}
