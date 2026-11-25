import { commandError } from "@core/command-error";
import type { HostId, LiveMsg } from "@core/generated/types";
import {
  awaitHistory,
  clearRows,
  reduceLive,
  settleSubscribe,
} from "@core/live-state";
import { POPOVER_CARD_SERIES } from "@core/popover/series";
import { failureReason } from "@core/remote-errors";
import { MINUTE_MS } from "@core/time-grid";
import type { LiveStore, PhoneLive } from "./live";
import type { PhoneTransport } from "./seam";

const RETRY_MS = [500, 1000, 2000, 5000];
const TERMINAL_FAILURES = new Set([
  "unknown_host",
  "remote_auth",
  "remote_identity",
  "host_key_unknown",
  "remote_incompatible",
  "remote_unsupported",
]);

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

function createFrameWatchdog(store: LiveStore, onTimeout: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const stop = () => {
    generation++;
    clearTimeout(timer);
  };
  const arm = (startedAt: number, reconnects: number) => {
    stop();
    const current = generation;
    const { status, lastFrame } = store.getState();
    if (!status || status.paused || status.display_idle) return;
    const period = Math.max(status.interval_ms, status.frame_period_ms);
    if (!Number.isFinite(period) || period <= 0) return;
    const sinceFrame = performance.now() - Math.max(startedAt, lastFrame ?? 0);
    timer = setTimeout(
      () => {
        if (current !== generation) return;
        store.setState({ stale: true });
        if (current === generation) {
          timer = setTimeout(
            () => {
              if (current === generation) onTimeout();
            },
            Math.min(MINUTE_MS, 3 * period * 2 ** reconnects)
          );
        }
      },
      Math.max(0, 3 * period - sinceFrame)
    );
  };
  return { arm, stop };
}

/** Start a host's live stream and return the cleanup for its callbacks and timers. */
export function subscribeHostLive(
  store: LiveStore,
  transport: PhoneTransport,
  host: HostId
) {
  let stopped = false;
  let generation = 0;
  let unsubscribe: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reconnects = 0;
  let startedAt = performance.now();
  const loggedFailures = new Set<string>();
  const watchdog = createFrameWatchdog(store, () => {
    console.warn("[live] replacing a silent subscription", {
      hostId: host,
      reason: "No live frames",
      lastTsMs: store.getState().lastTsMs,
      attempt: reconnects + 1,
    });
    reconnect();
  });

  function disconnect() {
    generation++;
    watchdog.stop();
    clearTimeout(retry);
    unsubscribe?.();
    unsubscribe = undefined;
  }

  function reconnect() {
    disconnect();
    reconnects++;
    void connect(0);
  }

  function apply(msg: LiveMsg) {
    const previous = store.getState();
    const next = reduceLive(previous, msg);
    if (msg.kind === "frame" && next !== previous) {
      reconnects = 0;
      store.setState({ ...next, lastFrame: performance.now() });
      watchdog.arm(startedAt, reconnects);
      return;
    }
    // Only a fresh frame proves a reconnect is live again.
    store.setState(
      previous.connection === "reconnecting" && next.connection === "live"
        ? { ...next, connection: "reconnecting" }
        : next
    );
    if (msg.kind === "status") watchdog.arm(startedAt, reconnects);
  }

  function subscribeFailed(attempt: number, error: unknown) {
    disconnect();
    const kind = commandError(error)?.kind;
    const reason = failureReason(error, "Couldn’t connect to this host.");
    const key = `${kind ?? ""}:${reason}`;
    if (!loggedFailures.has(key)) {
      console.error("[live] subscribe failed", { hostId: host, reason });
      loggedFailures.add(key);
    }
    const failure = kind && TERMINAL_FAILURES.has(kind) ? reason : null;
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
          if (!stopped && generation === current) apply(msg);
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
      loggedFailures.clear();
      const { backfill_rows, earlier_start_ms } = sub.info.data;
      if (backfill_rows === 0 && earlier_start_ms === null)
        store.setState(settleSubscribe);
      unsubscribe = sub.unsubscribe;
      watchdog.arm(startedAt, reconnects);
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
