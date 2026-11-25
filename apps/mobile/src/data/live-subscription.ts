import type { HostId, RemoteHostStatus } from "@core/generated/types";
import { createLiveSession, onLiveHostChanged } from "@core/live-session";
import { MINUTE_MS } from "@core/time-grid";
import { AppState } from "react-native";
import type { LiveStore, PhoneLive } from "./live";
import { PHONE_LIVE_SERIES } from "./live-series";
import type { PhoneTransport } from "./seam";

function applyPhoneState(store: LiveStore, host: HostId, next: PhoneLive) {
  const previous = store.getState();
  if (
    next.subscribeFailure?.first &&
    next.subscribeFailure !== previous.subscribeFailure
  ) {
    console.error("[live] subscribe failed", {
      hostId: host,
      reason: next.subscribeFailure.reason,
    });
  }
  if (next.watchdogAttempt > previous.watchdogAttempt) {
    console.warn("[live] replacing a silent subscription", {
      hostId: host,
      reason: "No live frames",
      lastTsMs: next.lastTsMs,
      attempt: next.watchdogAttempt,
    });
  }
  store.setState(
    {
      ...next,
      stream: previous.stream,
      connection: next.awaitingFrame ? "reconnecting" : next.connection,
      lastFrame:
        next.frameVersion === previous.frameVersion
          ? previous.lastFrame
          : performance.now(),
    },
    true
  );
}

/** Own a stream while the screen is focused. iOS releases it in the background. */
export function subscribeHostLive(
  store: LiveStore,
  transport: PhoneTransport,
  host: HostId,
  status: () => RemoteHostStatus | null,
  onStream: (stream: number, open: boolean) => void
) {
  let visible = AppState.currentState === "active";
  let release: (() => void) | undefined;
  let parked: "background" | "host-changed" | undefined;
  let notifyVisible: ((visible: boolean) => void) | undefined;
  const start = () => {
    const held = store.getState();
    if (held.frameVersion > 0)
      applyPhoneState(store, host, { ...held, awaitingFrame: true });
    return createLiveSession(
      host,
      { series: PHONE_LIVE_SERIES, backfillMs: MINUTE_MS },
      {
        initial: store.getState(),
        subscribe: async (id, onMessage, options) => {
          let stopped = false;
          let unsubscribe: (() => void) | undefined;
          let stream: number | undefined;
          const stop = () => {
            stopped = true;
            if (stream !== undefined) {
              onStream(stream, false);
              stream = undefined;
            }
            unsubscribe?.();
            unsubscribe = undefined;
            if (release === stop) release = undefined;
          };
          release = stop;
          try {
            const sub = await transport.subscribeLive(
              id,
              (msg) => {
                if (!stopped) onMessage(msg);
              },
              options
            );
            if (stopped) sub.unsubscribe();
            else {
              unsubscribe = () => sub.unsubscribe();
              if (sub.info.status === "ok") {
                stream = sub.info.data.stream;
                onStream(stream, true);
              }
            }
            return { ...sub, unsubscribe: stop };
          } catch (error) {
            stop();
            throw error;
          }
        },
        apply: (next) => applyPhoneState(store, host, next),
        clock: {
          now: () => Date.now() + (status()?.clock_offset_ms ?? 0),
          setTimeout,
          clearTimeout,
        },
        visible: () => visible,
        onVisible: (listener) => {
          notifyVisible = listener;
          return () => {
            notifyVisible = undefined;
          };
        },
        status,
      }
    );
  };
  let session = visible ? start() : undefined;
  const appState = AppState.addEventListener("change", (state) => {
    const active = state === "active";
    if (active === visible) return;
    visible = active;
    if (active && !session) {
      session = start();
      return;
    }
    if (!active && release) {
      parked = "background";
      release();
    }
    if (active && parked) {
      const shouldRetry =
        parked === "host-changed" ||
        !store.getState().subscribeFailure?.terminal;
      parked = undefined;
      if (shouldRetry) session?.retry();
    }
    notifyVisible?.(active);
  });
  const stopHostsChanged = onLiveHostChanged(transport, host, () => {
    if (!session) return;
    if (visible) session.retry();
    else parked = "host-changed";
  });
  return () => {
    appState.remove();
    stopHostsChanged();
    release?.();
    session?.stop();
  };
}
