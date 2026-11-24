/**
 * Presentation of an unreachable Docker engine for the Containers page: what happened,
 * what StatGlass is doing about it and the one action that fixes it. Rust decides the
 * reason (`DockerSnapshot.availability`); this module only words it.
 */
import type {
  DockerRuntimeApp,
  DockerRuntimeKind,
  DockerSnapshot,
  DockerStatus,
  DockerUnavailableReason,
} from "@core/generated/types";

/** The single recovery action the state card offers. */
export type EngineAction =
  | { kind: "launch"; runtime: DockerRuntimeKind; label: string }
  | { kind: "copy"; command: string; label: string }
  | { kind: "choose"; label: string }
  | { kind: "retry"; label: string };

/** Everything the engine state card renders. */
export interface EngineStateView {
  readonly tone: "info" | "warning" | "destructive";
  readonly title: string;
  readonly summary: string;
  readonly gifTheme: "not-found" | "network-error" | "server-error" | "timeout";
  readonly action: EngineAction | null;
  /** Offer Retry beside a primary action that isn't itself a retry. */
  readonly showRetry: boolean;
  /** Wall-clock ms of the next automatic attempt, for the countdown; null when none. */
  readonly nextAttemptMs: number | null;
  /** True during the post-launch window, while StatGlass waits for the engine. */
  readonly launching: boolean;
  /** Newest observation time when the engine has saved history, else null. */
  readonly lastReadingMs: number | null;
  /** Display name of the runtime the copy talks about, e.g. "Docker Desktop". */
  readonly runtimeName: string;
  /** Stable key for this state (the reason, or the status without one), for media seeds. */
  readonly stateKey: string;
}

/** The parts of the view that change with the reason. */
type StateCopy = Pick<
  EngineStateView,
  "tone" | "title" | "summary" | "gifTheme" | "action" | "showRetry"
>;

/** The runtime the copy names, and the installed app behind it when there is one. */
interface PrimaryRuntime {
  readonly name: string;
  readonly app: DockerRuntimeApp | null;
}

/** Statuses in which the page renders normally. */
const NORMAL_STATUSES: ReadonlySet<DockerStatus> = new Set([
  "connected",
  "connecting",
  "paused",
  "idle_suspended",
  "disabled",
]);
const GENERIC_RUNTIME_NAME = "Docker";
const COLIMA_START_COMMAND = "colima start";
const RETRY_ACTION: EngineAction = { kind: "retry", label: "Retry" };
const CHOOSE_ACTION: EngineAction = { kind: "choose", label: "Choose engine…" };

/**
 * Words an unreachable engine, or returns null when the page should render normally
 * (connected, connecting, paused, idle, or monitoring turned off).
 */
export function engineStateView(
  snapshot: DockerSnapshot,
  nowMs: number
): EngineStateView | null {
  if (NORMAL_STATUSES.has(snapshot.status)) return null;
  const runtime = primaryRuntime(snapshot);
  const launching = isLaunching(snapshot, nowMs);
  const copy = launching
    ? launchingCopy(runtime)
    : stateCopy(snapshot, runtime);
  return {
    ...copy,
    launching,
    nextAttemptMs:
      snapshot.status === "unavailable"
        ? (snapshot.availability?.next_attempt_ms ?? null)
        : null,
    lastReadingMs:
      snapshot.persistence.retained_from_ms === null
        ? null
        : snapshot.observed_ms,
    runtimeName: runtime.name,
    stateKey: snapshot.availability?.reason ?? snapshot.status,
  };
}

/**
 * The first launchable runtime in Rust's order, else Colima when it is the only kind
 * installed, else whatever the snapshot's engine calls itself.
 */
function primaryRuntime(snapshot: DockerSnapshot): PrimaryRuntime {
  const runtimes = snapshot.availability?.runtimes ?? [];
  const app =
    runtimes.find((runtime) => runtime.launchable) ??
    runtimes.find((runtime) => runtime.kind === "colima") ??
    null;
  return {
    name: app?.name ?? snapshot.engine?.runtime ?? GENERIC_RUNTIME_NAME,
    app,
  };
}

/** True while a launched runtime is still inside its startup window. */
function isLaunching(snapshot: DockerSnapshot, nowMs: number): boolean {
  const availability = snapshot.availability;
  if (snapshot.status !== "unavailable" || availability === null) return false;
  if (
    availability.reason !== "not_running" &&
    availability.reason !== "stopped"
  )
    return false;
  return (availability.launching_until_ms ?? 0) > nowMs;
}

/** How to start the runtime: open its app, copy Colima's command, or just retry. */
function startAction(runtime: PrimaryRuntime): EngineAction {
  if (runtime.app?.launchable)
    return {
      kind: "launch",
      runtime: runtime.app.kind,
      label: `Open ${runtime.name}`,
    };
  if (runtime.app?.kind === "colima")
    return {
      kind: "copy",
      command: COLIMA_START_COMMAND,
      label: "Copy command",
    };
  return RETRY_ACTION;
}

/** Copy for the status, or for the reason Rust gave while unavailable. */
function stateCopy(
  snapshot: DockerSnapshot,
  runtime: PrimaryRuntime
): StateCopy {
  if (snapshot.status === "permission_denied")
    return permissionDeniedCopy(snapshot);
  if (snapshot.status === "incompatible") return incompatibleCopy(runtime);
  const reason = snapshot.availability?.reason;
  if (reason === undefined) return unansweredCopy(snapshot);
  return reasonCopy(reason, snapshot, runtime);
}

/** Copy for each reason Rust reports with an unavailable engine. */
function reasonCopy(
  reason: DockerUnavailableReason,
  snapshot: DockerSnapshot,
  runtime: PrimaryRuntime
): StateCopy {
  switch (reason) {
    case "not_running":
      return notRunningCopy(runtime);
    case "stopped":
      return stoppedCopy(runtime);
    case "not_installed":
      return notInstalledCopy();
    case "choose_engine":
      return chooseEngineCopy();
    case "selected_missing":
      return selectedMissingCopy(snapshot);
  }
}

/** A runtime was just opened and StatGlass is waiting for its engine. */
function launchingCopy(runtime: PrimaryRuntime): StateCopy {
  return {
    tone: "info",
    title: `Starting ${runtime.name}…`,
    summary:
      "Waiting for the engine to answer. This usually takes a few seconds.",
    gifTheme: "timeout",
    action: null,
    showRetry: false,
  };
}

function notRunningCopy(runtime: PrimaryRuntime): StateCopy {
  const action = startAction(runtime);
  const start =
    action.kind === "copy"
      ? `Start ${runtime.name} from Terminal`
      : `Start ${runtime.name}`;
  return {
    tone: "warning",
    title: `${runtime.name} isn’t running`,
    summary: `${start} to see live container activity. StatGlass connects as soon as the engine answers.`,
    gifTheme: "network-error",
    action,
    showRetry: action.kind !== "retry",
  };
}

function stoppedCopy(runtime: PrimaryRuntime): StateCopy {
  const action = startAction(runtime);
  return {
    tone: "warning",
    title: `${runtime.name} stopped`,
    summary: `The engine stopped answering. Start ${runtime.name} again to resume live readings.`,
    gifTheme: "network-error",
    action,
    showRetry: action.kind !== "retry",
  };
}

function notInstalledCopy(): StateCopy {
  return {
    tone: "info",
    title: "No Docker engine found",
    summary:
      "StatGlass monitors Docker Desktop, OrbStack, Colima and Rancher Desktop. Install or start one and this page connects on its own.",
    gifTheme: "not-found",
    action: RETRY_ACTION,
    showRetry: false,
  };
}

function chooseEngineCopy(): StateCopy {
  return {
    tone: "info",
    title: "Choose a Docker engine",
    summary:
      "More than one engine is running. Pick the one StatGlass should monitor.",
    gifTheme: "server-error",
    action: CHOOSE_ACTION,
    showRetry: false,
  };
}

function selectedMissingCopy(snapshot: DockerSnapshot): StateCopy {
  const selected = snapshot.settings.selected_engine ?? "The selected engine";
  return {
    tone: "warning",
    title: "The selected engine is gone",
    summary: `${selected} no longer exists. Choose another engine to keep monitoring.`,
    gifTheme: "not-found",
    action: CHOOSE_ACTION,
    showRetry: false,
  };
}

function permissionDeniedCopy(snapshot: DockerSnapshot): StateCopy {
  const socket = snapshot.engine?.socket ?? "the Docker socket";
  return {
    tone: "destructive",
    title: "StatGlass can’t open the Docker socket",
    summary: `macOS refused access to ${socket}. Check the socket’s permissions, then retry.`,
    gifTheme: "server-error",
    action: RETRY_ACTION,
    showRetry: false,
  };
}

function incompatibleCopy(runtime: PrimaryRuntime): StateCopy {
  return {
    tone: "destructive",
    title: "This Docker engine is too old",
    summary: `StatGlass needs Docker Engine API 1.40 or newer (Docker 19.03+). Update ${runtime.name}, then retry.`,
    gifTheme: "server-error",
    action: RETRY_ACTION,
    showRetry: false,
  };
}

/** Unavailable without a reason from Rust: say so plainly and keep retrying. */
function unansweredCopy(snapshot: DockerSnapshot): StateCopy {
  return {
    tone: "warning",
    title: "Docker isn’t answering",
    summary:
      snapshot.message ?? "StatGlass will keep trying to reach the engine.",
    gifTheme: "network-error",
    action: RETRY_ACTION,
    showRetry: false,
  };
}
