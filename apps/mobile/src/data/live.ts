import { commandErrorText } from "@core/command-error";
import type { HostId } from "@core/generated/types";
import {
  initialLiveSessionState,
  type LiveSessionState,
} from "@core/live-session";
import type { HostLive } from "@core/live-state";
import {
  hostStatusSummary,
  type PhoneRemoteHostRecord,
} from "@core/phone-connection";
import { hostKeys } from "@core/query-keys";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { subscribeHostLive } from "./live-subscription";
import type { PhoneTransport } from "./seam";
import { usePhoneTransport } from "./transport-context";

/** Held host data and the phone's connection state. */
export interface PhoneLive extends LiveSessionState {
  /** Monotonic receipt time. Backfill alone does not make a frame fresh. */
  lastFrame: number | null;
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
      ...initialLiveSessionState(host),
      lastFrame: null,
    }));
    hosts.set(host, store);
  }
  return store;
}

/** Run a screen's live work only while it is focused and foregrounded. */
export function useFocusedAppEffect(start: () => (() => void) | undefined) {
  useFocusEffect(
    useCallback(() => {
      let stop: (() => void) | undefined;
      const onState = (state: string) => {
        if (state === "active") {
          stop ??= start();
        } else {
          stop?.();
          stop = undefined;
        }
      };
      const listener = AppState.addEventListener("change", onState);
      if (AppState.currentState) onState(AppState.currentState);
      return () => {
        listener.remove();
        stop?.();
      };
    }, [start])
  );
}

function cachedRemoteStatus(client: QueryClient, host: HostId) {
  return (
    client
      .getQueryData<PhoneRemoteHostRecord[]>(hostKeys.remote())
      ?.find(({ config }) => config.id === host)?.status ?? null
  );
}

/** Only the focused host page owns a live subscription. */
export function useHostLiveSubscription(host: HostId) {
  const transport = usePhoneTransport();
  const client = useQueryClient();
  useFocusEffect(
    useCallback(
      () =>
        subscribeHostLive(hostStore(transport, host), transport, host, () =>
          cachedRemoteStatus(client, host)
        ),
      [client, host, transport]
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

/** Show a terminal failure from the current remote host status. */
export function useLiveFailure(host: HostId) {
  const { data: status } = useRemoteStatus(host);
  if (status?.state !== "error" || status.failure_kind === null) return null;
  return hostStatusSummary(status, { nowMs: Date.now() }).label || null;
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

/** Explain an error from the local core's status read. */
export function connectionStatusError(error: unknown) {
  return `Couldn’t read connection status. ${commandErrorText(error, "Please try again.")}`;
}
