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
import {
  agentVersionState,
  connectionLabel,
  type HostVersionState,
  localVersionState,
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

function system(host: HostRecord | undefined): string {
  return host
    ? [host.info.os_version, host.info.kernel, host.info.chip]
        .filter(Boolean)
        .join(" · ") || MISSING
    : MISSING;
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
    isLive: true,
  };
  if (status.identity_changed)
    return {
      ...base,
      status: "Identity changed",
      mark: "warn",
      isLive: false,
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
      isLive: false,
      message: {
        tone: "note",
        text: "Update StatGlass on this host to reconnect. Mirrored history stays available here.",
      },
    };
  switch (status.state) {
    case "connected":
      return {
        ...base,
        route: connectionLabel(remote).replace(" · connected", ""),
      };
    case "connecting":
      return { ...base, status: "Connecting…", mark: "idle", isLive: false };
    case "offline":
      return {
        ...base,
        status: "Offline",
        mark: "idle",
        isLive: false,
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
        isLive: false,
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
        isLive: false,
        stateAction: "Retry",
        message: {
          tone: "error",
          text: status.error ?? "The SSH connection failed.",
        },
      };
  }
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
    cpu: formatPercent(state.isLive ? remote.status.cpu_pct : null),
    memory: formatPercent(state.isLive ? remote.status.memory_pct : null),
    ...readings(remote.status.vitals, state.isLive),
  };
}

export function localHostCardModel(
  host: HostRecord,
  vitals: HostVitals | null,
  version: string,
  target: string | null,
  cpu: number | null,
  _memory: number | null,
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
    system: system(host),
    version: localVersionState(version, target),
    cpu: formatPercent(cpu),
    memory: formatPercent(vitals?.memory_pct),
    ...readings(vitals, true),
  };
}
