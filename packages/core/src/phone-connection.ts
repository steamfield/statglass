import { formatClock } from "./format";
import type {
  CommandError,
  IncompatibleSide,
  RemoteFailureKind,
  RemoteHostRecord,
  RemoteHostStatus,
} from "./generated/types";

export type Tone = "live" | "muted" | "warning";

export type PhoneRemoteHostStatus = RemoteHostStatus & {
  incompatible_side?: IncompatibleSide | null;
  open_error?: CommandError | null;
};

export type PhoneRemoteHostRecord = Omit<
  RemoteHostRecord,
  "config" | "status"
> & {
  config: Omit<RemoteHostRecord["config"], "mirror_budget_mb">;
  status: PhoneRemoteHostStatus;
};

export type PhoneProblemKind =
  | "key_not_accepted"
  | "no_longer_authorized"
  | "host_key_changed"
  | "identity_changed"
  | "update_host"
  | "update_app"
  | "incompatible"
  | "app_not_running"
  | "monitoring_off"
  | "agent_not_running"
  | "tailscale_down"
  | "local_network"
  | "name_not_resolved"
  | "timeout"
  | "refused"
  | "unreachable"
  | "local_offline"
  | "offline"
  | "phone_key_unavailable"
  | "internal";
export type PhoneAction =
  | "retry"
  | "re_pair"
  | "open_settings"
  | "open_tailscale";
export interface PhoneProblem {
  kind: PhoneProblemKind;
  title: string;
  short: string;
  recovery: string;
  action: PhoneAction | null;
  tone: Tone;
}

type HostProblemKind = Exclude<PhoneProblemKind, "local_network">;
type Advice = Pick<PhoneProblem, "title" | "recovery">;
export const PHONE_OFFLINE_TITLE = "This iPhone is offline";

/** Recovery copy shared by the Mac and iPhone when a host stops monitoring. */
export function macMonitoringAdvice(
  kind: "app_not_running" | "monitoring_off",
  host: string
): Advice {
  return kind === "app_not_running"
    ? {
        title: `StatGlass isn't running on ${host}`,
        recovery: `Open StatGlass on ${host}, then retry.`,
      }
    : {
        title: `Remote monitoring is off on ${host}`,
        recovery: `Turn on Allow remote monitoring in StatGlass Settings on ${host}, then retry.`,
      };
}

const commandKinds: Partial<Record<CommandError["kind"], RemoteFailureKind>> = {
  remote_auth: "authentication",
  host_key_unknown: "host_key",
  remote_identity: "identity_changed",
  remote_incompatible: "incompatible",
  remote_refused: "incompatible",
  remote_unreachable: "unreachable",
  remote_agent_not_running: "agent_not_running",
  remote_not_running: "app_not_running",
  remote_monitoring_off: "monitoring_off",
};

const failureProblem: Record<
  Exclude<
    RemoteFailureKind,
    "authentication" | "incompatible" | "no_route" | "unreachable"
  >,
  HostProblemKind
> = {
  app_not_running: "app_not_running",
  monitoring_off: "monitoring_off",
  agent_not_running: "agent_not_running",
  identity_changed: "identity_changed",
  host_key: "host_key_changed",
  name_not_resolved: "name_not_resolved",
  refused: "refused",
  timeout: "timeout",
  protocol: "internal",
  local_offline: "local_offline",
  tailscale_down: "tailscale_down",
  phone_key_unavailable: "phone_key_unavailable",
  internal: "internal",
};

const updateProblem = { host: "update_host", app: "update_app" } as const;

function typedFailure(status: PhoneRemoteHostStatus) {
  if (status.open_error)
    return commandKinds[status.open_error.kind] ?? "internal";
  // Rust picks the most actionable failure when multiple routes fail.
  return (
    status.failure_kind ??
    (status.route_failures.length === 1 ? status.route_failures[0]?.kind : null)
  );
}

export function phoneWaitingForNetwork(status: PhoneRemoteHostStatus): boolean {
  // Rust clears the wait flag when a retry is scheduled or starts dialing.
  return (
    status.state !== "connected" &&
    status.state !== "disabled" &&
    status.waiting_for_network &&
    status.next_attempt_ms === null &&
    !status.dialing
  );
}

function hostProblemKind(
  status: PhoneRemoteHostStatus
): HostProblemKind | null {
  if (
    status.state === "connected" ||
    status.state === "disabled" ||
    status.dialing
  )
    return null;
  if (phoneWaitingForNetwork(status)) return "local_offline";
  if (status.state === "error" && status.identity_changed !== null) {
    return "identity_changed";
  }

  const failure = typedFailure(status);
  if (failure) return classifyFailure(failure, status);
  if (status.state === "connecting") return null;
  return status.state === "offline" ? "offline" : "internal";
}

function classifyFailure(
  failure: RemoteFailureKind,
  status: PhoneRemoteHostStatus
): HostProblemKind {
  switch (failure) {
    case "authentication":
      return status.last_seen_ms === null
        ? "key_not_accepted"
        : "no_longer_authorized";
    case "incompatible":
      return status.incompatible_side
        ? updateProblem[status.incompatible_side]
        : "incompatible";
    case "no_route":
    case "unreachable":
      return status.last_seen_ms === null ? "unreachable" : "offline";
    default:
      return failureProblem[failure];
  }
}

const copy: Record<
  HostProblemKind,
  {
    short: string;
    action: PhoneAction | null;
    advice(host: string, status: PhoneRemoteHostStatus): Advice;
  }
> = {
  key_not_accepted: {
    short: "Key not accepted by sshd",
    action: "re_pair",
    advice: (host) => ({
      title: "Key not accepted by sshd",
      recovery: `Pair with ${host} again to install this iPhone’s key for the SSH account.`,
    }),
  },
  no_longer_authorized: {
    short: "iPhone no longer authorized",
    action: "re_pair",
    advice: (host) => ({
      title: `This iPhone is no longer authorized on ${host}`,
      recovery: `Pair with ${host} again to restore access from this iPhone.`,
    }),
  },
  host_key_changed: {
    short: "SSH host key changed",
    action: "re_pair",
    advice: (host) => ({
      title: `The SSH host key changed on ${host}`,
      recovery:
        "Confirm the new SSH fingerprint with the host owner before pairing again.",
    }),
  },
  identity_changed: {
    short: "Host identity changed",
    action: "re_pair",
    advice: (host) => ({
      title: "Re-pair as a new host",
      recovery: `${host} reported a different identity. Confirm it was replaced or reinstalled before pairing again.`,
    }),
  },
  update_host: {
    short: "Host update needed",
    action: null,
    advice: (host) => ({
      title: `Update StatGlass on ${host}`,
      recovery: `Install a newer version of StatGlass on ${host} to connect from this iPhone.`,
    }),
  },
  update_app: {
    short: "iPhone app update needed",
    action: null,
    advice: () => ({
      title: "Update this app",
      recovery: "Get the latest StatGlass update from the App Store.",
    }),
  },
  incompatible: {
    short: "Incompatible StatGlass connection",
    action: null,
    advice: (host) => ({
      title: `Can’t connect to ${host} with this StatGlass version`,
      recovery: `Check that ${host} is running a compatible version of StatGlass and allows remote monitoring.`,
    }),
  },
  app_not_running: {
    short: "StatGlass isn’t running",
    action: "retry",
    advice: (host) => macMonitoringAdvice("app_not_running", host),
  },
  monitoring_off: {
    short: "Remote monitoring is off",
    action: "retry",
    advice: (host) => macMonitoringAdvice("monitoring_off", host),
  },
  agent_not_running: {
    short: "StatGlass agent isn’t running",
    action: "retry",
    advice: (host) => ({
      title: `The StatGlass agent isn’t running on ${host}`,
      recovery: `Start the StatGlass agent on ${host}, or wait for its update to finish.`,
    }),
  },
  tailscale_down: {
    short: "Tailscale is off",
    action: "open_tailscale",
    advice: () => ({
      title: "Tailscale is off on this iPhone",
      recovery:
        "Open the Tailscale app and connect Tailscale to reach this host.",
    }),
  },
  name_not_resolved: {
    short: "Host name not found",
    action: "retry",
    advice: (host) => ({
      title: `Couldn’t find ${host}`,
      recovery:
        "Check the host name and connect to the network where it’s available.",
    }),
  },
  timeout: {
    short: "Connection timed out",
    action: "retry",
    advice: (host, status) => ({
      title: `Connection to ${host} timed out`,
      recovery: status.route_failures.some(
        ({ route, kind }) => route === "tailscale" && kind === "timeout"
      )
        ? "Check that the host is online and your tailnet access rules allow SSH from this iPhone."
        : "Check that the host is online and that your network allows SSH, then retry.",
    }),
  },
  refused: {
    short: "SSH connection refused",
    action: "retry",
    advice: (host) => ({
      title: `${host} refused the SSH connection`,
      recovery: `Check that SSH is enabled on ${host}, then retry.`,
    }),
  },
  unreachable: {
    short: "Host unreachable",
    action: "retry",
    advice: (host) => ({
      title: `Can’t reach ${host}`,
      recovery:
        "Check that the host is online and reachable from this network, then retry.",
    }),
  },
  local_offline: {
    short: "Waiting for network",
    action: null,
    advice: () => ({
      title: PHONE_OFFLINE_TITLE,
      recovery: "Connect to Wi-Fi or cellular to resume monitoring.",
    }),
  },
  offline: {
    short: "Offline",
    action: "retry",
    advice: (host) => ({
      title: `${host} is offline`,
      recovery: `Check that ${host} is awake and online, then retry.`,
    }),
  },
  phone_key_unavailable: {
    short: "iPhone key unavailable",
    action: "retry",
    advice: () => ({
      title: "Unlock this iPhone to connect",
      recovery:
        "Unlock your iPhone and retry. Re-pair if the key is still unavailable.",
    }),
  },
  internal: {
    short: "Connection failed",
    action: "retry",
    advice: internalAdvice,
  },
};

function internalAdvice(host: string, status: PhoneRemoteHostStatus): Advice {
  if (status.open_error?.kind === "invalid_argument") {
    return {
      title: `Check the connection settings for ${host}`,
      recovery: "Check the saved host address and SSH settings, then retry.",
    };
  }
  if (status.open_error) {
    return {
      title: `Couldn’t start the connection to ${host}`,
      recovery: "Retry. If the problem continues, close and reopen StatGlass.",
    };
  }
  if (typedFailure(status) === "protocol") {
    return {
      title: `Couldn’t read the response from ${host}`,
      recovery: `Retry the connection. If it fails again, check the StatGlass versions on this iPhone and ${host}.`,
    };
  }
  return {
    title: `StatGlass lost its connection to ${host}`,
    recovery:
      "Retry to start a new connection. If it fails again, close and reopen StatGlass and try again.",
  };
}

function problemTone(kind: HostProblemKind): Tone {
  return kind === "offline" || kind === "local_offline" ? "muted" : "warning";
}

function problemShort(
  kind: HostProblemKind,
  status: PhoneRemoteHostStatus
): string {
  if (kind === "internal" && status.open_error) {
    return status.open_error.kind === "invalid_argument"
      ? "Check connection settings"
      : "Couldn’t start connection";
  }
  if (kind === "internal" && typedFailure(status) === "protocol") {
    return "Couldn’t read host response";
  }
  return copy[kind].short;
}

export function phoneProblem(
  { config, status }: PhoneRemoteHostRecord,
  _nowMs: number
): PhoneProblem | null {
  const kind = hostProblemKind(status);
  if (!kind) return null;
  const { action, advice } = copy[kind];
  return {
    kind,
    short: problemShort(kind, status),
    action,
    tone: problemTone(kind),
    ...advice(config.name, status),
  };
}

function problemLabel(
  kind: HostProblemKind,
  status: PhoneRemoteHostStatus,
  tone: Tone
): string {
  const short = problemShort(kind, status);
  // MobileRemoteHost.last_seen_ms is already in the host's clock.
  const offlineTime =
    status.last_seen_ms === null
      ? null
      : `Offline since ${formatClock(status.last_seen_ms)}`;
  if (kind === "offline") return offlineTime ?? short;
  const label = tone === "warning" ? `Needs attention · ${short}` : short;
  return kind === "timeout" && offlineTime
    ? `${label} · ${offlineTime}`
    : label;
}

export function hostStatusSummary(
  status: PhoneRemoteHostStatus | null,
  { nowMs }: { nowMs: number }
): { label: string; tone: Tone; stale: boolean } {
  if (!status)
    return { label: "Status unavailable", tone: "muted", stale: false };
  if (status.state === "connected")
    return { label: "Live", tone: "live", stale: false };
  if (status.state === "disabled")
    return { label: "Disabled", tone: "muted", stale: false };

  const kind = hostProblemKind(status);
  const tone = kind ? problemTone(kind) : "muted";
  const connectingLabel =
    status.dialing && status.last_seen_ms !== null
      ? "Reconnecting"
      : "Connecting";
  let label = kind ? problemLabel(kind, status, tone) : connectingLabel;
  // MobileRemoteHost.next_attempt_ms uses the phone's wall clock.
  if (status.next_attempt_ms !== null && status.next_attempt_ms >= nowMs) {
    label += ` · Retrying at ${formatClock(status.next_attempt_ms)}`;
  }
  return { label, tone, stale: status.last_seen_ms !== null };
}
