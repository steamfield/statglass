import { commandError } from "./command-error";
import type {
  HostId,
  LiveMsg,
  RemoteHostStatus,
  SubscriptionInfo,
} from "./generated/types";
import {
  awaitHistory,
  clearRows,
  type HostLive,
  initialHostLive,
  reduceLive,
  settleSubscribe,
} from "./live-state";
import { failureReason } from "./remote-errors";
import { MINUTE_MS } from "./time-grid";
import type {
  LiveOptions as LiveRequest,
  LiveSubscription,
  Transport,
} from "./transport";

/** Delays after a failed subscribe, capped at the last step. */
const RETRY_MS = [500, 1000, 2000, 5000];
/** Frame periods without a sample before the stream reads stale (plan 4.17). */
const STALE_INTERVALS = 3;
/**
 * Additional stale periods before replacing a stream Rust may have ended silently.
 * The wait doubles per attempt without a frame, capped at a minute.
 */
const RECONNECT_INTERVALS = 3;

export interface LiveSessionState extends HostLive {
  /** The most recent subscription's inline catch-up window. */
  recentMs: number | null;
  stream: SubscriptionInfo["stream"] | null;
  /** Advances only when the reducer accepts a frame. */
  frameVersion: number;
  /** A replacement can refill history before its first frame arrives. */
  awaitingFrame: boolean;
  /** Number of watchdog replacements since the last frame. */
  watchdogAttempt: number;
  subscribeFailure: { error: unknown; reason: string; first: boolean } | null;
  terminal: RemoteHostStatus | null;
}

export function initialLiveSessionState(host: HostId): LiveSessionState {
  return {
    ...initialHostLive(host),
    recentMs: null,
    stream: null,
    frameVersion: 0,
    awaitingFrame: false,
    watchdogAttempt: 0,
    subscribeFailure: null,
    terminal: null,
  };
}

export interface LiveSessionDeps<S> {
  initial: S;
  subscribe: Transport["subscribeLive"];
  apply(state: S): void;
  clock: {
    /** Current wall time in the host's clock, for comparing sample times. */
    now(): number;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  visible(): boolean;
  onVisible(listener: (visible: boolean) => void): () => void;
  status(): RemoteHostStatus | null;
}

function prepareCatchUp<S extends LiveSessionState>(
  state: S,
  now: number,
  backfillMs: number
): S {
  const { interval_ms: interval = 0 } = state.status ?? {};
  const { lastTsMs, recentMs } = state;
  // Earlier chunks can only prepend. Leave two ticks for subscription setup and
  // refill the ring when either subscription window could leave a hole.
  return lastTsMs !== null &&
    recentMs !== null &&
    now - lastTsMs + 2 * interval >= Math.min(recentMs, backfillMs)
    ? clearRows(state)
    : state;
}

function framePeriod(state: HostLive): number {
  const status = state.status;
  if (!status || status.paused || status.display_idle) return 0;
  const period = Math.max(status.interval_ms, status.frame_period_ms);
  return Number.isFinite(period) && period > 0 ? period : 0;
}

class LiveSession<S extends LiveSessionState> {
  private state: S;
  private stopped = false;
  private generation = 0;
  private unsubscribe: (() => void) | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private onShow: (() => void) | undefined;
  private readonly unlisten: () => void;
  private readonly loggedFailures = new Set<string>();

  constructor(
    private readonly host: HostId,
    private readonly request: LiveRequest,
    private readonly deps: LiveSessionDeps<S>
  ) {
    this.state = deps.initial;
    this.unlisten = deps.onVisible((visible) => this.onVisibility(visible));
    // The desktop registers while hidden so Rust can start the channel on show.
    void this.connect(0);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.unlisten();
    this.disconnect();
    this.publish(settleSubscribe(this.state));
  }

  /** Rebind an owned stream even while its view is hidden. */
  retry() {
    if (!this.stopped) this.replace(false);
  }

  private publish(next: S) {
    if (next === this.state) return;
    this.state = next;
    this.deps.apply(next);
  }

  private disconnect() {
    const { clearTimeout } = this.deps.clock;
    this.generation++;
    clearTimeout(this.watchdog);
    clearTimeout(this.retryTimer);
    this.onShow = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.state.stream !== null)
      this.publish({ ...this.state, stream: null });
  }

  private whenVisible(action: () => void) {
    if (this.stopped) return;
    if (this.deps.visible()) action();
    else this.onShow = action;
  }

  private onVisibility(visible: boolean) {
    if (this.stopped) return;
    if (!visible) {
      const { clearTimeout } = this.deps.clock;
      clearTimeout(this.watchdog);
      return;
    }
    const resume = this.onShow;
    this.onShow = undefined;
    if (resume) resume();
    else if (this.unsubscribe) this.armWatchdog();
  }

  private armWatchdog() {
    const { setTimeout, clearTimeout } = this.deps.clock;
    clearTimeout(this.watchdog);
    const period = framePeriod(this.state);
    if (this.stopped || !period || !this.deps.visible()) return;
    this.watchdog = setTimeout(() => {
      if (this.stopped || !this.deps.visible()) return;
      const wait = Math.min(
        MINUTE_MS,
        RECONNECT_INTERVALS * period * 2 ** this.state.watchdogAttempt
      );
      this.watchdog = setTimeout(() => {
        if (!this.stopped && this.deps.visible() && this.state.stale)
          this.replace(true);
      }, wait);
      if (!this.state.stale) this.publish({ ...this.state, stale: true });
    }, STALE_INTERVALS * period);
  }

  private applyMessage(msg: LiveMsg) {
    const state = this.state;
    const reduced = reduceLive(state, msg);
    if (reduced === state) return;
    if (msg.kind === "frame") {
      this.publish({
        ...reduced,
        frameVersion: state.frameVersion + 1,
        awaitingFrame: false,
        watchdogAttempt: 0,
        terminal: null,
      });
      this.armWatchdog();
      return;
    }
    this.publish(reduced);
    if (msg.kind === "status") this.armWatchdog();
  }

  private hostIsTerminal() {
    const status = this.deps.status();
    // Rust reports retryable connection failures as connecting.
    const terminal =
      status?.state === "error" && status.failure_kind !== null ? status : null;
    if (terminal !== this.state.terminal)
      this.publish({ ...this.state, terminal });
    return terminal !== null;
  }

  private scheduleRetry(attempt: number) {
    const { setTimeout } = this.deps.clock;
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(
      () =>
        this.whenVisible(() => {
          // Recheck cached status with the same backoff so a recovered source can
          // resume automatically without sending subscription commands while blocked.
          if (this.hostIsTerminal()) this.scheduleRetry(attempt + 1);
          else void this.connect(attempt + 1);
        }),
      delay
    );
  }

  private failed(attempt: number, error: unknown) {
    this.disconnect();
    const reason = failureReason(error, "Couldn’t start live updates.");
    const key = `${commandError(error)?.kind ?? ""}:${reason}`;
    const first = !this.loggedFailures.has(key);
    this.loggedFailures.add(key);
    this.publish({
      ...settleSubscribe(this.state),
      connection: "reconnecting",
      awaitingFrame: true,
      subscribeFailure: { error, reason, first },
    });
    this.hostIsTerminal();
    this.scheduleRetry(attempt);
  }

  private accept(sub: LiveSubscription, attempt: number, current: number) {
    if (this.stopped || this.generation !== current) {
      sub.unsubscribe();
      return;
    }
    if (sub.info.status === "error") {
      sub.unsubscribe();
      this.failed(attempt, sub.info.error);
      return;
    }
    this.unsubscribe = sub.unsubscribe;
    this.loggedFailures.clear();
    const { backfill_rows, earlier_start_ms, recent_ms, stream } =
      sub.info.data;
    const next =
      backfill_rows === 0 && earlier_start_ms === null
        ? settleSubscribe(this.state)
        : this.state;
    this.publish({
      ...next,
      recentMs: recent_ms,
      stream,
      subscribeFailure: null,
    });
    this.armWatchdog();
  }

  private async connect(attempt: number) {
    const current = ++this.generation;
    this.publish(
      awaitHistory(
        prepareCatchUp(
          this.state,
          this.deps.clock.now(),
          this.request.backfillMs ?? MINUTE_MS
        )
      )
    );
    try {
      const sub = await this.deps.subscribe(
        this.host,
        (msg) => {
          if (!this.stopped && this.generation === current)
            this.applyMessage(msg);
        },
        this.request
      );
      this.accept(sub, attempt, current);
    } catch (error) {
      if (!this.stopped && this.generation === current)
        this.failed(attempt, error);
    }
  }

  private replace(watchdogExpired: boolean) {
    this.disconnect();
    const blocked = watchdogExpired && this.hostIsTerminal();
    this.publish({
      ...this.state,
      connection: "reconnecting",
      awaitingFrame: true,
      watchdogAttempt:
        this.state.watchdogAttempt + Number(watchdogExpired && !blocked),
    });
    if (blocked) this.scheduleRetry(0);
    else void this.connect(0);
  }
}

/**
 * Own one live stream, including replacements and their outstanding replies.
 * Rust uses `backfillMs` as its recovery horizon. Keep the full request on each
 * reconnect so later show or wake can still recover the whole window.
 */
export function createLiveSession<S extends LiveSessionState>(
  host: HostId,
  request: LiveRequest,
  deps: LiveSessionDeps<S>
): { stop(): void; retry(): void } {
  const session = new LiveSession(host, request, deps);
  return { stop: () => session.stop(), retry: () => session.retry() };
}
