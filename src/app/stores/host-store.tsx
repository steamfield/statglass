/**
 * The scoped live store, one per host (architecture.md "Live state: one store
 * per host"). Adapted from opendata's `/ask` conversation store: the same
 * `createStore` + context provider + `useState` initializer, so the store is
 * a per-provider instance that dies with its subtree, never a module-level
 * singleton, and consumers read it through a selector so a 1 Hz frame only
 * re-renders what changed.
 *
 * Providers nest into a registry keyed `hosts[hostId]` (v4 shows several
 * hosts in one window); `useHost` reads the nearest provider's host unless a
 * host id is passed.
 */
import type {
  HostId,
  RemoteHostRecord,
  SeriesSelector,
} from "@core/generated/types";
import {
  createLiveSession,
  initialLiveSessionState,
  type LiveSessionState,
  onLiveHostChanged,
} from "@core/live-session";
import { ProcessInterest } from "@core/process-interest";
import { hostKeys } from "@core/query-keys";
import { MINUTE_MS } from "@core/time-grid";
import type { Transport } from "@core/transport";
import { QueryClientContext } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import { useHostClock } from "~/lib/host-clock";
import { useTransport } from "~/lib/transport-context";

export interface HostLiveState extends LiveSessionState {
  /**
   * This window's process interest for the host (D-066): consumers add
   * their views, the union goes to Rust with the live stream's id. The same
   * object for the store's life.
   */
  processInterest: ProcessInterest;
}

export type HostStore = StoreApi<HostLiveState>;

export function createHostStore(
  hostId: HostId,
  transport?: Transport
): HostStore {
  const interest = new ProcessInterest((view, stream) => {
    if (!transport) return;
    void transport
      .setProcessInterest(hostId, view !== null, view, stream)
      .then((r) => {
        if (r.status === "error") {
          console.error("[processes] set_process_interest failed", {
            hostId,
            window: transport.windowLabel(),
            view,
            error: r.error,
          });
        }
      });
  });
  return createStore<HostLiveState>()(() => ({
    ...initialLiveSessionState(hostId),
    processInterest: interest,
  }));
}

const HostsContext = createContext<Readonly<Record<HostId, HostStore>>>({});
const CurrentHostContext = createContext<HostId | null>(null);

function windowVisible() {
  return document.visibilityState !== "hidden";
}

interface LiveRequest {
  backfillMs: number;
  series: readonly SeriesSelector[] | undefined;
}

function useLiveSubscription(
  store: HostStore,
  transport: Transport,
  hostId: HostId,
  request: LiveRequest
) {
  const { backfillMs } = request;
  // Selectors by value: a new array with the same series is no resubscribe.
  const seriesKey = JSON.stringify(request.series ?? null);
  const clock = useHostClock();
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const seriesRef = useRef(request.series);
  seriesRef.current = request.series;
  const client = useContext(QueryClientContext);

  // biome-ignore lint/correctness/useExhaustiveDependencies: seriesKey stands for request.series, read through seriesRef.
  useEffect(() => {
    const series = seriesRef.current;
    let stopping = false;
    const session = createLiveSession(
      hostId,
      { backfillMs, ...(series === undefined ? {} : { series }) },
      {
        initial: store.getState(),
        subscribe: (...args) => transport.subscribeLive(...args),
        apply: (next) => {
          const previous = store.getState();
          if (
            next.subscribeFailure &&
            next.subscribeFailure !== previous.subscribeFailure
          ) {
            console.error("[live] subscribe failed", {
              hostId,
              window: transport.windowLabel(),
              reason: next.subscribeFailure.error,
            });
          }
          if (next.watchdogAttempt > previous.watchdogAttempt) {
            console.warn("[live] no frames while visible; resubscribing", {
              hostId,
              window: transport.windowLabel(),
              lastTsMs: next.lastTsMs,
              attempt: next.watchdogAttempt,
            });
          }
          if (!stopping && next.stream !== previous.stream)
            next.processInterest.setStream(next.stream);
          store.setState(next, true);
        },
        clock: { now: () => clockRef.current(), setTimeout, clearTimeout },
        visible: windowVisible,
        onVisible: (listener) => {
          const onChange = () => listener(windowVisible());
          document.addEventListener("visibilitychange", onChange);
          return () =>
            document.removeEventListener("visibilitychange", onChange);
        },
        status: () =>
          client
            ?.getQueryData<RemoteHostRecord[]>(hostKeys.remote())
            ?.find(({ config }) => config.id === hostId)?.status ?? null,
      }
    );

    // Registration can replace the source while the window is hidden, paused, or idle.
    const stopHostsChanged = onLiveHostChanged(
      transport,
      hostId,
      session.retry
    );
    return () => {
      stopHostsChanged();
      // Child cleanups still withdraw their interest using the last stream id.
      stopping = true;
      session.stop();
    };
  }, [store, transport, hostId, backfillMs, seriesKey, client]);
}

/**
 * One live store for `hostId`, subscribed while mounted. Key the provider by
 * host id at the call site if the host can change.
 */
export function HostStoreProvider({
  hostId,
  backfillMs = MINUTE_MS,
  series,
  children,
}: {
  hostId: HostId;
  /** Ring history to request on subscribe (D-049). Default 60 s. */
  backfillMs?: number | undefined;
  /** The series this window draws (D-066); omitted means every series. */
  series?: readonly SeriesSelector[] | undefined;
  children: ReactNode;
}) {
  const transport = useTransport();
  const [store] = useState(() => createHostStore(hostId, transport));
  useLiveSubscription(store, transport, hostId, { backfillMs, series });
  const parent = useContext(HostsContext);
  const hosts = useMemo(
    () => ({ ...parent, [hostId]: store }),
    [parent, hostId, store]
  );
  return (
    <HostsContext.Provider value={hosts}>
      <CurrentHostContext.Provider value={hostId}>
        {children}
      </CurrentHostContext.Provider>
    </HostsContext.Provider>
  );
}

/** The store instance for `hostId`, or the nearest provider's host. */
export function useHostStore(hostId?: HostId): HostStore {
  const hosts = useContext(HostsContext);
  const current = useContext(CurrentHostContext);
  const id = hostId ?? current;
  const store = id === null ? undefined : hosts[id];
  if (!store) {
    throw new Error(
      `useHostStore: no <HostStoreProvider> for host ${id ?? "(none)"}`
    );
  }
  return store;
}

/** The current host's id. */
export function useHostId(): HostId {
  const current = useContext(CurrentHostContext);
  if (current === null) {
    throw new Error("useHostId must be used within a <HostStoreProvider>");
  }
  return current;
}

/**
 * Read a slice of a host's live state. Return primitives, or wrap the
 * selector in `useShallow` when it builds an object; a fresh object from a
 * plain selector re-renders the caller on every frame.
 */
export function useHost<T>(
  selector: (state: HostLiveState) => T,
  hostId?: HostId
): T {
  return useStore(useHostStore(hostId), selector);
}
