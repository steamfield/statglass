import { commandErrorText } from "@core/command-error";
import type { HostId, RemoteHostStatus } from "@core/generated/types";
import {
  initialLiveSessionState,
  type LiveSessionState,
} from "@core/live-session";
import {
  hostStatusSummary,
  type PhoneRemoteHostRecord,
  type PhoneRemoteHostStatus,
} from "@core/phone-connection";
import { hostKeys } from "@core/query-keys";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { useStore } from "zustand";
import { shallow } from "zustand/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import { PagerHost, useFocusDemand } from "./demand";
import { subscribeHostLive } from "./live-subscription";
import type { PhoneTransport } from "./seam";
import { usePhoneTransport } from "./transport-context";

/** Held host data and the phone's connection state. */
export interface PhoneLive extends LiveSessionState {
  /** Monotonic receipt time. Backfill alone does not make a frame fresh. */
  lastFrame: number | null;
  stream: number | null;
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
      stream: null,
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
  const current = useContext(PagerHost);
  const enabled = current === null || current === host;
  useFocusDemand(current === host ? host : null, "full");
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const store = hostStore(transport, host);
      return subscribeHostLive(
        store,
        transport,
        host,
        () => cachedRemoteStatus(client, host),
        (stream, open) => {
          if (open || store.getState().stream === stream) {
            store.setState({ stream: open ? stream : null });
          }
        }
      );
    }, [client, enabled, host, transport])
  );
}

export function useHostLiveStream(host: HostId) {
  return useLiveSelection(host, (state) => state.stream);
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

/**
 * A subscribe for this host is in flight or open. False for a host the phone
 * hasn't subscribed to (a neighbouring pager page), and from a failed
 * subscribe until one succeeds, so its retries don't flip the cards' shape.
 */
export function subscribing(state: PhoneLive): boolean {
  return (
    state.subscribeFailure === null &&
    (state.historyPending === "subscribe" || state.stream !== null)
  );
}

/**
 * The host's first data is on its way: subscribed, nothing held yet, and the
 * host is sampling (a paused or display-idle host sends no frames to wait for).
 */
export function awaitingFirstData(state: PhoneLive): boolean {
  return (
    state.lastTsMs === null &&
    !state.status?.paused &&
    !state.status?.display_idle &&
    subscribing(state)
  );
}

/** Subscribe to just the selected part of a host's held live state. */
export function useHostLive<T>(
  host: HostId,
  select: (state: PhoneLive) => T,
  equal?: (a: T, b: T) => boolean
): T {
  return useLiveSelection(host, select, equal);
}

/** The phone's monotonic receipt time for the last frame, or null before one arrives. */
export function useLastFrame(host: HostId) {
  return useLiveSelection(host, (state) => state.lastFrame);
}

/** Show a terminal subscribe reply or a failure from the caller's remote status. */
export function useLiveFailure(
  host: HostId,
  remote: RemoteHostStatus | undefined
) {
  const failure = useLiveSelection(host, ({ subscribeFailure }) =>
    subscribeFailure?.terminal ? subscribeFailure.reason : null
  );
  if (failure !== null) return failure;
  if (remote?.state !== "error" || remote.failure_kind === null) return null;
  return hostStatusSummary(remote, { nowMs: Date.now() }).label || null;
}

const routeNames = { lan: "LAN", tailscale: "Tailscale" };

/** The remote status line used by both the host and module pages. */
export function remoteStatusLine(remote: PhoneRemoteHostStatus | undefined) {
  return remote && remote.state !== "connected"
    ? hostStatusSummary(remote, { nowMs: Date.now() })
    : null;
}

/** Connection state shared by the pill and the module's current readings. */
export function useConnection(
  host: HostId,
  remote: PhoneRemoteHostStatus | undefined,
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
  const failure = useLiveFailure(host, remote);
  const remoteLine = remoteStatusLine(remote);
  const statusLine = statusError ?? remoteLine?.label ?? failure;

  if (statusLine) {
    return {
      state:
        !statusError && remote?.state === "connecting"
          ? "reconnecting"
          : "offline",
      label: statusLine,
      remoteState: statusError ? "status-read-failed" : remote?.state,
      problemKind: remoteLine?.kind,
    } as const;
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
  const route = remote?.route ? routeNames[remote.route] : null;
  return {
    state: "live",
    label: "Live",
    route,
  } as const;
}

/** Explain an error from the local core's status read. */
export function connectionStatusError(error: unknown) {
  return `Couldn’t read connection status. ${commandErrorText(error, "Please try again.")}`;
}
