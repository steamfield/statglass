import {
  fixed,
  formatBytes,
  formatDateTime,
  formatPercent,
  formatRate,
  MISSING,
} from "@core/format";
import type {
  HostRecord,
  HostVitals,
  RemoteHostRecord,
  RrJob,
} from "@core/generated/bindings";
import { remoteConnectionView } from "@core/remote-connection";
import { routePhrase } from "@core/remote-connection-network";
import {
  agentVersionState,
  type HostVersionState,
  localVersionState,
  routeLabel,
} from "@core/remote-hosts";

export interface HostCardModel {
  id: string;
  name: string;
  status: string;
  mark: "live" | "idle" | "paused" | "error" | "warn";
  route: string;
  message: { text: string; tone: "note" | "error" } | null;
  version: HostVersionState;
  stateAction: "Retry" | "Turn on" | "Re-pair…" | null;
  isLive: boolean;
  /** Automatic retry state for a failing remote card; null for live, local or paused cards. */
  retry: { nextAttemptMs: number | null; dialing: boolean } | null;
  /** The panel that replaces the metric lanes on a remote card that isn't live; null otherwise. */
  reconnect: HostCardReconnectModel | null;
  system: string;
  cpu: string;
  memory: string;
  diskWarning: string | null;
  rr: {
    command: string | null;
    detail: string;
    startedMs: number;
    clockOffsetMs: number;
  } | null;
  vitals: { label: string; value: string; secondary?: string }[];
}

/** What a non-live remote card says about its connection in place of its readings. */
export interface HostCardReconnectModel {
  /** What is happening: "Reconnecting to Studio", "Waiting for network", … */
  headline: string;
  /** The classified one-line cause. */
  cause: string;
  /** `warning` while a failing host retries; `muted` while waiting, connecting or off. */
  tone: "warning" | "muted";
  /** `schedule` shows the countdown or the attempt in flight; `network` waits for this Mac. */
  timing: "schedule" | "network" | "none";
  /** The routes an attempt dials, e.g. "LAN (studio.local)". */
  routes: string;
  /** Secondary facts: the attempt count once retries slow down, and the last reading. */
  facts: string[];
}

/** Attempts at which the facts row starts explaining the slowing retries. */
const SLOWING_ATTEMPT = 2;

function reconnectHeadline(
  remote: RemoteHostRecord,
  status: string
): Pick<HostCardReconnectModel, "headline" | "tone" | "timing"> {
  const { config, status: s } = remote;
  if (s.waiting_for_network)
    return {
      headline: "Waiting for network",
      tone: "muted",
      timing: "network",
    };
  if (s.identity_changed || s.agent_update.kind === "required")
    return { headline: status, tone: "warning", timing: "none" };
  if (s.state === "disabled")
    return { headline: "Connection off", tone: "muted", timing: "none" };
  if (s.state === "connecting" && s.failure_kind === null)
    return {
      headline: `Connecting to ${config.name}`,
      tone: "muted",
      timing: "schedule",
    };
  return {
    headline: `Reconnecting to ${config.name}`,
    tone: "warning",
    timing: "schedule",
  };
}

function reconnectFacts(remote: RemoteHostRecord): string[] {
  const { status } = remote;
  const facts: string[] = [];
  if (status.attempt >= SLOWING_ATTEMPT)
    facts.push(`Attempt ${status.attempt} · retries slow to once a minute`);
  const lastReadingMs = status.last_seen_ms ?? status.synced_through_ms;
  if (lastReadingMs !== null)
    facts.push(`Last reading ${formatDateTime(lastReadingMs)}`);
  return facts;
}

/** The reconnect panel for a remote card that isn't live; null for a live one. */
function reconnectPanel(
  remote: RemoteHostRecord,
  state: Pick<HostCardModel, "isLive" | "status" | "message">
): HostCardReconnectModel | null {
  if (state.isLive) return null;
  const view = remoteConnectionView(remote);
  return {
    ...reconnectHeadline(remote, state.status),
    // The card's own message is the most specific line (identity, update, network
    // cause); the panel shows it in place of the message row.
    cause: state.message?.text ?? view.shortReason,
    routes: routePhrase(view.routes),
    facts: reconnectFacts(remote),
  };
}

function system(host: HostRecord | undefined): string {
  return host
    ? [host.info.os_version, host.info.kernel, host.info.chip]
        .filter(Boolean)
        .join(" · ") || MISSING
    : MISSING;
}

export function isLiveHost({ status }: RemoteHostRecord): boolean {
  return (
    status.state === "connected" &&
    !status.identity_changed &&
    status.agent_update.kind !== "required"
  );
}

function connectingState(
  remote: RemoteHostRecord,
  base: Pick<
    HostCardModel,
    "status" | "mark" | "route" | "message" | "stateAction" | "isLive"
  >
) {
  const { status } = remote;
  if (status.failure_kind === null) {
    return { ...base, status: "Connecting…", mark: "idle" as const };
  }
  const route =
    status.last_seen_ms !== null
      ? `Last seen ${formatDateTime(status.last_seen_ms)}`
      : status.synced_through_ms !== null
        ? `History through ${formatDateTime(status.synced_through_ms)}`
        : "";
  const offline = status.failure_kind === "local_offline";
  return {
    ...base,
    status: offline ? "Waiting for network" : "Reconnecting…",
    mark: offline ? ("idle" as const) : ("warn" as const),
    route,
    stateAction: "Retry" as const,
    // While this Mac is offline the Hosts page notice explains it once for every card.
    message: status.waiting_for_network
      ? null
      : {
          tone: "note" as const,
          text: remoteConnectionView(remote).shortReason,
        },
  };
}

/** The automatic retry schedule, only for a card that offers Retry (a failing remote). */
function retrySchedule(
  remote: RemoteHostRecord,
  stateAction: HostCardModel["stateAction"]
): HostCardModel["retry"] {
  if (stateAction !== "Retry") return null;
  return {
    nextAttemptMs: remote.status.next_attempt_ms,
    dialing: remote.status.dialing,
  };
}

function connection(
  remote: RemoteHostRecord
): Pick<
  HostCardModel,
  "status" | "mark" | "route" | "message" | "stateAction" | "isLive"
> {
  const { status } = remote;
  const route =
    status.route === "lan"
      ? "LAN"
      : status.route === "tailscale"
        ? "Tailscale"
        : "";
  const base: Pick<
    HostCardModel,
    "status" | "mark" | "route" | "message" | "stateAction" | "isLive"
  > = {
    status: "Live",
    mark: "live",
    route,
    message: null,
    stateAction: null,
    isLive: isLiveHost(remote),
  };
  if (status.identity_changed)
    return {
      ...base,
      status: "Identity changed",
      mark: "warn",
      stateAction: "Re-pair…",
      message: {
        tone: "note",
        text: "This host now answers with a different identity.",
      },
    };
  if (status.agent_update.kind === "required")
    return {
      ...base,
      status: "Update required",
      mark: "warn",
      message: {
        tone: "note",
        text: "Update StatGlass on this host to reconnect. Mirrored history stays available here.",
      },
    };
  switch (status.state) {
    case "connected":
      return {
        ...base,
        route: routeLabel(remote),
      };
    case "connecting":
      return connectingState(remote, base);
    case "offline":
      return {
        ...base,
        status: "Offline",
        mark: "idle",
        route:
          status.last_seen_ms === null
            ? ""
            : `Last seen ${formatDateTime(status.last_seen_ms)}`,
        stateAction: "Retry",
        message: {
          tone: "note",
          text: "The host is unreachable. StatGlass retries automatically; mirrored history stays available here.",
        },
      };
    case "disabled":
      return {
        ...base,
        status: "Connection off",
        mark: "paused",
        stateAction: "Turn on",
        message: {
          tone: "note",
          text: "Automatic connections are off. History already copied stays on this Mac.",
        },
      };
    case "error":
      return {
        ...base,
        status: "Connection failed",
        mark: "error",
        stateAction: "Retry",
        message: {
          tone: "error",
          text: errorMessage(remote),
        },
      };
  }
}

/** The classified short reason when Rust named a failure kind, else the raw SSH error. */
function errorMessage(remote: RemoteHostRecord): string {
  const { status } = remote;
  if (status.failure_kind === null) {
    return status.error ?? "The SSH connection failed.";
  }
  return remoteConnectionView(remote).shortReason;
}

function pressure(vitals: HostVitals | null): string {
  const pressure = vitals?.memory_pressure;
  if (!pressure) return MISSING;
  if (pressure.kind === "stall")
    return `Some ${formatPercent(pressure.some_pct, { significantDigits: 3 })}`;
  return pressure.kind === "level"
    ? (["Normal", "Warn", "Critical"][pressure.level] ?? MISSING)
    : MISSING;
}

/** Formatting of Rust facts only; the low-disk decision is never inferred here. */
function readings(vitals: HostVitals | null, live: boolean) {
  const v = live ? vitals : null;
  const disk =
    v?.disk_used_bytes != null &&
    v.disk_total_bytes != null &&
    v.disk_total_bytes > 0
      ? formatPercent((v.disk_used_bytes / v.disk_total_bytes) * 100)
      : MISSING;
  return {
    diskWarning: v?.disk_low ? `Disk ${disk}` : null,
    vitals: [
      {
        label: "Load",
        value: v?.load_1m == null ? MISSING : fixed(v.load_1m, 2),
        ...(v?.cores == null ? {} : { secondary: `of ${v.cores} cores` }),
      },
      { label: "Mem pressure", value: pressure(v) },
      {
        label: "Disk",
        value: disk,
        ...(v?.disk_free_bytes == null
          ? {}
          : { secondary: `${formatBytes(v.disk_free_bytes)} free` }),
      },
      {
        label: "Network",
        value:
          v?.net_rx_bps == null ? MISSING : `↓ ${formatRate(v.net_rx_bps)}`,
        ...(v?.net_tx_bps == null
          ? {}
          : { secondary: `↑ ${formatRate(v.net_tx_bps)}` }),
      },
    ],
  };
}

function rrBand(
  job: RrJob | null,
  live: boolean,
  hosts: readonly HostRecord[],
  clockOffsetMs: number
): HostCardModel["rr"] {
  if (!live || !job) return null;
  const names = job.peers.map((id) => {
    const host = hosts.find((host) => host.id === id);
    return host?.is_local ? "This Mac" : (host?.display_name ?? id);
  });
  const peers =
    names.slice(0, 2).join(", ") +
    (names.length > 2 ? ` and ${names.length - 2} more` : "");
  return {
    command: job.command,
    detail: `From ${job.client_hostname}${peers ? ` · also on ${peers}` : ""}`,
    startedMs: job.started_ms,
    clockOffsetMs,
  };
}

export function remoteHostCardModel(
  remote: RemoteHostRecord,
  host?: HostRecord,
  hosts: readonly HostRecord[] = []
): HostCardModel {
  const state = connection(remote);
  return {
    ...state,
    retry: retrySchedule(remote, state.stateAction),
    reconnect: reconnectPanel(remote, state),
    rr: rrBand(
      remote.status.rr,
      state.isLive,
      hosts,
      remote.status.clock_offset_ms ?? 0
    ),
    id: remote.config.id,
    name: remote.config.name,
    system: system(host),
    version: agentVersionState(remote),
    cpu: formatPercent(state.isLive ? remote.status.vitals.cpu_pct : null),
    memory: formatPercent(
      state.isLive ? remote.status.vitals.memory_pct : null
    ),
    ...readings(remote.status.vitals, state.isLive),
  };
}

export function localHostCardModel(
  host: HostRecord,
  vitals: HostVitals | null,
  version: string,
  target: string | null,
  job: RrJob | null = null,
  hosts: readonly HostRecord[] = []
): HostCardModel {
  return {
    id: host.id,
    name: "This Mac",
    rr: rrBand(job, true, hosts, 0),
    status: "Live",
    mark: "live",
    route: "This Mac",
    message: null,
    stateAction: null,
    isLive: true,
    retry: null,
    reconnect: null,
    system: system(host),
    version: localVersionState(version, target),
    cpu: MISSING,
    memory: formatPercent(vitals?.memory_pct),
    ...readings(vitals, true),
  };
}
