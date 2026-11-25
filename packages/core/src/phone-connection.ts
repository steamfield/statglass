import { formatClock } from "./format";
import type {
  CommandError,
  IncompatibleSide,
  MobileRemoteHost,
  RemoteFailureKind,
  RemoteHostRecord,
  RemoteHostStatus,
} from "./generated/types";
import { macMonitoringAdvice } from "./remote-errors";

export type Tone = "live" | "muted" | "warning";

export type PhoneRemoteHostStatus = RemoteHostStatus & {
  demand?: MobileRemoteHost["demand"];
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

type ProblemVariant =
  | PhoneProblemKind
  | "invalid_endpoint"
  | "open_failed"
  | "protocol";
type Advice = Pick<PhoneProblem, "title" | "recovery">;
export const PHONE_OFFLINE_TITLE = "This iPhone is offline";

const commandKinds: Partial<Record<CommandError["kind"], ProblemVariant>> = {
  invalid_argument: "invalid_endpoint",
  internal: "open_failed",
};

const failureProblem: Record<
  Exclude<
    RemoteFailureKind,
    "authentication" | "incompatible" | "timeout" | "no_route" | "unreachable"
  >,
  ProblemVariant
> = {
  app_not_running: "app_not_running",
  monitoring_off: "monitoring_off",
  agent_not_running: "agent_not_running",
  identity_changed: "identity_changed",
  host_key: "host_key_changed",
  name_not_resolved: "name_not_resolved",
  refused: "refused",
  protocol: "protocol",
  local_offline: "local_offline",
  tailscale_down: "tailscale_down",
  phone_key_unavailable: "phone_key_unavailable",
  internal: "internal",
};

const updateProblem = { host: "update_host", app: "update_app" } as const;

export function phoneWaitingForNetwork(status: PhoneRemoteHostStatus): boolean {
  return status.waiting_for_network;
}

function problemVariant(status: PhoneRemoteHostStatus): ProblemVariant | null {
  if (
    status.state === "connected" ||
    status.state === "disabled" ||
    status.dialing
  )
    return null;
  if (phoneWaitingForNetwork(status)) return "local_offline";
  if (status.open_error)
    return commandKinds[status.open_error.kind] ?? "open_failed";
  if (status.state === "error" && status.identity_changed !== null) {
    return "identity_changed";
  }

  // Rust picks the most actionable failure when multiple routes fail.
  const failure =
    status.failure_kind ??
    (status.route_failures.length === 1
      ? status.route_failures[0]?.kind
      : null);
  if (failure) return classifyFailure(failure, status);
  if (status.state === "connecting") return null;
  return status.state === "offline" ? "offline" : "internal";
}

function classifyFailure(
  failure: RemoteFailureKind,
  status: PhoneRemoteHostStatus
): ProblemVariant {
  switch (failure) {
    case "authentication":
      return status.last_seen_ms === null
        ? "key_not_accepted"
        : "no_longer_authorized";
    case "incompatible":
      return status.incompatible_side
        ? updateProblem[status.incompatible_side]
        : "incompatible";
    // A host we have seen is offline when a timeout or network path failure leaves it unreachable.
    case "timeout":
      return status.last_seen_ms === null ? "timeout" : "offline";
    case "no_route":
    case "unreachable":
      return status.last_seen_ms === null ? "unreachable" : "offline";
    default:
      return failureProblem[failure];
  }
}

const copy = {
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
  local_network: {
    short: "Local Network access needed",
    action: "open_settings",
    advice: () => ({
      title: "StatGlass needs Local Network access",
      recovery: "Allow Local Network access for StatGlass in Settings.",
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
      title: "This iPhone’s key is unavailable",
      recovery:
        "Unlock your iPhone and retry. Re-pair if the key is still unavailable.",
    }),
  },
  internal: {
    short: "Connection failed",
    action: "retry",
    advice: (host) => ({
      title: `StatGlass lost its connection to ${host}`,
      recovery:
        "Retry to start a new connection. If it fails again, close and reopen StatGlass and try again.",
    }),
  },
  invalid_endpoint: {
    short: "Check connection settings",
    action: "retry",
    advice: (host) => ({
      title: `Check the connection settings for ${host}`,
      recovery: "Check the saved host address and SSH settings, then retry.",
    }),
  },
  open_failed: {
    short: "Couldn’t start connection",
    action: "retry",
    advice: (host) => ({
      title: `Couldn’t start the connection to ${host}`,
      recovery: "Retry. If the problem continues, close and reopen StatGlass.",
    }),
  },
  protocol: {
    short: "Couldn’t read host response",
    action: "retry",
    advice: (host) => ({
      title: `Couldn’t read the response from ${host}`,
      recovery: `Retry the connection. If it fails again, check the StatGlass versions on this iPhone and ${host}.`,
    }),
  },
} satisfies Record<
  ProblemVariant,
  {
    short: string;
    action: PhoneAction | null;
    advice(host: string, status: PhoneRemoteHostStatus): Advice;
  }
>;

function publicKind(variant: ProblemVariant): PhoneProblemKind {
  switch (variant) {
    case "invalid_endpoint":
    case "open_failed":
    case "protocol":
      return "internal";
    default:
      return variant;
  }
}

function problemTone(kind: PhoneProblemKind): Tone {
  return kind === "offline" || kind === "local_offline" ? "muted" : "warning";
}

/** Recovery to use when the native layer detects Local Network denial. */
export function localNetworkProblem(): PhoneProblem {
  const kind = "local_network";
  const { short, action, advice } = copy[kind];
  return { kind, short, action, tone: problemTone(kind), ...advice() };
}

export function phoneProblem({
  config,
  status,
}: PhoneRemoteHostRecord): PhoneProblem | null {
  const variant = problemVariant(status);
  if (!variant) return null;
  const kind = publicKind(variant);
  const { short, action, advice } = copy[variant];
  return {
    kind,
    short,
    action,
    tone: problemTone(kind),
    ...advice(config.name, status),
  };
}

function problemLabel(
  variant: ProblemVariant,
  status: PhoneRemoteHostStatus,
  tone: Tone
): string {
  if (variant === "offline" && status.last_seen_ms !== null) {
    // MobileRemoteHost.last_seen_ms is already in the host's clock.
    return `Offline since ${formatClock(status.last_seen_ms)}`;
  }
  const { short } = copy[variant];
  return tone === "warning" ? `Needs attention · ${short}` : short;
}

export function hostStatusSummary(
  status: PhoneRemoteHostStatus | null,
  { nowMs }: { nowMs: number }
): { label: string; tone: Tone; kind: PhoneProblemKind | null } {
  if (!status)
    return { label: "Status unavailable", tone: "muted", kind: null };
  if (status.state === "connected")
    return { label: "Live", tone: "live", kind: null };
  if (status.state === "disabled")
    return { label: "Disabled", tone: "muted", kind: null };

  const variant = problemVariant(status);
  const kind = variant ? publicKind(variant) : null;
  const tone = kind ? problemTone(kind) : "muted";
  const connectingLabel =
    status.dialing && status.last_seen_ms !== null
      ? "Reconnecting"
      : "Connecting";
  let label = variant ? problemLabel(variant, status, tone) : connectingLabel;
  // Compare against the phone clock, then format in the host clock.
  if (status.next_attempt_ms !== null && status.next_attempt_ms >= nowMs) {
    label += ` · Retrying at ${formatClock(status.next_attempt_ms + (status.clock_offset_ms ?? 0))}`;
  }
  return { label, tone, kind };
}
