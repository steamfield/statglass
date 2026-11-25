import { commandError } from "@core/command-error";
import type { HostId, LiveMsg } from "@core/generated/types";
import {
  awaitHistory,
  clearRows,
  type HostLive,
  initialHostLive,
  reduceLive,
  settleSubscribe,
} from "@core/live-state";
import { POPOVER_CARD_SERIES } from "@core/popover/series";
import { hostKeys } from "@core/query-keys";
import { failureReason } from "@core/remote-errors";
import { MINUTE_MS } from "@core/time-grid";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PhoneTransport } from "./seam";
import { usePhoneTransport } from "./transport-context";

interface PhoneLive extends HostLive {
  /** Monotonic receipt time. Backfill alone does not make a frame fresh. */
  lastFrame: number | null;
  failure: string | null;
}

type LiveStore = StoreApi<PhoneLive>;
const stores = new WeakMap<PhoneTransport, Map<HostId, LiveStore>>();
const RETRY_MS = [500, 1000, 2000, 5000];
const TERMINAL_FAILURES = new Set([
  "unknown_host",
  "remote_auth",
  "remote_identity",
  "host_key_unknown",
  "remote_incompatible",
  "remote_unsupported",
]);

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

function startCatchUp(state: PhoneLive, startedAt: number, first: boolean) {
  // Only one minute can be refilled. Drop older holes, retaining the readouts.
  const missed =
    state.lastFrame !== null && startedAt - state.lastFrame >= MINUTE_MS;
  const next = missed ? clearRows(state) : state;
  return awaitHistory<PhoneLive>({
    ...next,
    failure: null,
    connection:
      next.lastFrame === null && first ? next.connection : "reconnecting",
  });
}

function terminalFailure(error: unknown) {
  const typed = commandError(error);
  return typed && TERMINAL_FAILURES.has(typed.kind)
    ? failureReason(error, "Couldn’t connect to this host.")
    : null;
}

function subscribe(store: LiveStore, transport: PhoneTransport, host: HostId) {
  let stopped = false;
  let generation = 0;
  let unsubscribe: (() => void) | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reconnects = 0;
  let startedAt = performance.now();

  function disconnect() {
    generation++;
    clearTimeout(watchdog);
    clearTimeout(retry);
    unsubscribe?.();
    unsubscribe = undefined;
  }

  function reconnect() {
    disconnect();
    reconnects++;
    void connect(0);
  }

  function watchFrames(attempt: number) {
    clearTimeout(watchdog);
    const { status, lastFrame } = store.getState();
    if (!status || status.paused || status.display_idle) return;
    const period = Math.max(status.interval_ms, status.frame_period_ms);
    if (!Number.isFinite(period) || period <= 0) return;
    const sinceFrame = performance.now() - Math.max(startedAt, lastFrame ?? 0);
    watchdog = setTimeout(
      () => {
        if (stopped || generation !== attempt) return;
        store.setState({ stale: true });
        watchdog = setTimeout(
          () => {
            if (stopped || generation !== attempt) return;
            reconnect();
          },
          Math.min(MINUTE_MS, 3 * period * 2 ** reconnects)
        );
      },
      Math.max(0, 3 * period - sinceFrame)
    );
  }

  function apply(msg: LiveMsg, attempt: number) {
    const previous = store.getState();
    const next = reduceLive(previous, msg);
    if (msg.kind === "frame" && next !== previous) {
      reconnects = 0;
      store.setState({ ...next, lastFrame: performance.now() });
      watchFrames(attempt);
    } else {
      // A backfill may carry many readings, but only a fresh frame proves
      // this subscription is live again.
      store.setState(
        previous.connection === "reconnecting" && next.connection === "live"
          ? { ...next, connection: "reconnecting" }
          : next
      );
      if (msg.kind === "status") watchFrames(attempt);
    }
  }

  function subscribeFailed(attempt: number, error: unknown) {
    disconnect();
    const failure = terminalFailure(error);
    store.setState((state) => ({
      ...settleSubscribe(state),
      connection: "reconnecting",
      failure,
    }));
    if (failure !== null) return;
    retry = setTimeout(
      () => void connect(attempt + 1),
      RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
    );
  }

  async function connect(attempt: number) {
    const current = ++generation;
    startedAt = performance.now();
    store.setState((state) => startCatchUp(state, startedAt, current === 1));
    try {
      const sub = await transport.subscribeLive(
        host,
        (msg) => {
          if (!stopped && generation === current) apply(msg, current);
        },
        { series: POPOVER_CARD_SERIES, backfillMs: MINUTE_MS }
      );
      if (stopped || generation !== current) {
        sub.unsubscribe();
        return;
      }
      if (sub.info.status === "error") {
        subscribeFailed(attempt, sub.info.error);
        sub.unsubscribe();
        return;
      }
      const { backfill_rows, earlier_start_ms } = sub.info.data;
      if (backfill_rows === 0 && earlier_start_ms === null) {
        store.setState(settleSubscribe);
      }
      unsubscribe = sub.unsubscribe;
      watchFrames(current);
    } catch (error) {
      if (!stopped && generation === current) subscribeFailed(attempt, error);
    }
  }

  const stopHostsChanged = transport.onHostsChanged(({ hosts }) => {
    if (hosts.some((record) => record.id === host && !record.is_local))
      reconnect();
  });
  void connect(0);
  return () => {
    stopped = true;
    stopHostsChanged();
    disconnect();
    store.setState(settleSubscribe);
  };
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

/** Only the focused host page owns a live subscription. */
export function useHostLiveSubscription(host: HostId) {
  const transport = usePhoneTransport();
  useFocusedAppEffect(
    useCallback(
      () => subscribe(hostStore(transport, host), transport, host),
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

export function useLastFrame(host: HostId) {
  return useLiveSelection(host, (state) => state.lastFrame);
}

export function useLiveFailure(host: HostId) {
  return useLiveSelection(host, (state) => state.failure);
}

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
