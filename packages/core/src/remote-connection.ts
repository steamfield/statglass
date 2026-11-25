import { formatDateTime } from "@core/format";
import type {
  RemoteFailureKind,
  RemoteHostRecord,
} from "@core/generated/types";
import {
  buildRouteLines,
  macMonitoringCopy,
  networkCauseCopy,
  networkHint,
  routePhrase,
  timeoutCopy,
} from "./remote-connection-network";

export type RemoteConnectionKind =
  | "connected"
  | "connecting"
  | "unreachable"
  | "timeout"
  | "auth"
  | "host_key"
  | "agent_not_running"
  | "app_not_running"
  | "monitoring_off"
  | "update_required"
  | "identity_changed"
  | "disabled"
  | "protocol"
  | "name_not_resolved"
  | "refused"
  | "no_route"
  | "local_offline"
  | "tailscale_down";

export type RemoteConnectionTone = "info" | "warning" | "destructive";

export type RemotePrimaryAction = "retry" | "enable" | "open_hosts";

/**
 * The illustration a connection failure shows. Each app maps these names onto its
 * own artwork; on the desktop they are `@steamfield/ui/gif` theme names.
 */
export type ConnectionGifTheme =
  | "not-found"
  | "server-error"
  | "network-error"
  | "timeout"
  | "coming-soon"
  | "overloaded";

export interface ConfiguredRoute {
  readonly kind: "lan" | "tailscale";
  readonly label: "LAN" | "Tailscale";
  readonly alias: string;
}

export interface RemoteConnectionView {
  readonly kind: RemoteConnectionKind;
  readonly tone: RemoteConnectionTone;
  readonly title: string;
  readonly summary: string;
  /** Short one-line cause suitable for compact Surfaces like HostCard. */
  readonly shortReason: string;
  readonly meta: string;
  readonly routes: readonly ConfiguredRoute[];
  /** The configured routes as one phrase, e.g. "LAN (studio.local) or Tailscale (studio)". */
  readonly routeText: string;
  /** Durable mirrored history watermark (remote host clock epoch ms), or null when none. */
  readonly syncedThroughMs: number | null;
  readonly hasSavedHistory: boolean;
  readonly gifTheme: ConnectionGifTheme | null;
  readonly gifSeed: string;
  readonly primaryAction: RemotePrimaryAction | null;
  readonly showRetry: boolean;
  readonly diagnostics: string;
  /** One line per failed route, e.g. "LAN (studio.local): name not found on this network". */
  readonly routeLines: readonly string[];
  /** This Mac's wall-clock ms of the next automatic attempt, or null when none is scheduled. */
  readonly nextAttemptMs: number | null;
  /** A connection attempt is in flight. */
  readonly dialing: boolean;
  /** This Mac is offline and the host waits for the network to come back. */
  readonly waitingForNetwork: boolean;
  readonly sidebarLabel: string;
  readonly pillLabel: string;
}

export function configuredRoutes(
  config: RemoteHostRecord["config"]
): ConfiguredRoute[] {
  const routes: ConfiguredRoute[] = [];
  if (config.lan) {
    routes.push({ kind: "lan", label: "LAN", alias: config.lan });
  }
  if (config.tailscale) {
    routes.push({
      kind: "tailscale",
      label: "Tailscale",
      alias: config.tailscale,
    });
  }
  return routes;
}

function formatAge(deltaMs: number): string {
  const sec = Math.max(0, Math.round(deltaMs / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  return `${days} d ago`;
}

function classifyFailure(remote: RemoteHostRecord): RemoteConnectionKind {
  const { status } = remote;
  if (status.identity_changed !== null) return "identity_changed";
  if (status.agent_update.kind === "required") return "update_required";
  if (status.state === "connected") return "connected";
  if (status.state === "disabled") return "disabled";
  if (status.state === "connecting" && status.failure_kind === null) {
    return "connecting";
  }
  const kind: RemoteFailureKind | null = status.failure_kind;
  switch (kind) {
    case "timeout":
      return "timeout";
    case "authentication":
      return "auth";
    case "host_key":
      return "host_key";
    case "agent_not_running":
      return "agent_not_running";
    case "incompatible":
      return "update_required";
    case "identity_changed":
      return "identity_changed";
    case "protocol":
      return "protocol";
    case "name_not_resolved":
      return "name_not_resolved";
    case "refused":
      return "refused";
    case "no_route":
      return "no_route";
    case "local_offline":
      return "local_offline";
    case "tailscale_down":
      return "tailscale_down";
    case "app_not_running":
    case "monitoring_off":
      return kind;
    case "unreachable":
    case null:
      return "unreachable";
  }
}

function historyFact(
  status: RemoteHostRecord["status"],
  nowMs: number
): string {
  if (status.last_seen_ms !== null) {
    return `Last seen ${formatAge(nowMs - status.last_seen_ms)}`;
  }
  if (status.synced_through_ms !== null) {
    return `Saved history through ${formatDateTime(status.synced_through_ms)}`;
  }
  return "Never connected";
}

function buildDiagnostics(
  remote: RemoteHostRecord,
  kind: RemoteConnectionKind,
  routes: readonly ConfiguredRoute[]
): string {
  const { config, status, os } = remote;
  const lines = [
    `Host: ${config.name} (${config.id})`,
    `OS: ${os === "mac_os" ? "macOS" : "Linux"}`,
    `State: ${status.state} (${kind})`,
    `Routes: ${routes.length > 0 ? routes.map((r) => `${r.label}=${r.alias}`).join(", ") : "none"}`,
  ];
  if (status.last_seen_ms !== null) {
    lines.push(`Last seen: ${new Date(status.last_seen_ms).toISOString()}`);
  }
  if (status.synced_through_ms !== null) {
    lines.push(
      `History synced through: ${new Date(status.synced_through_ms).toISOString()}`
    );
  }
  for (const failure of status.route_failures) {
    lines.push(
      `Route ${failure.route === "lan" ? "LAN" : "Tailscale"}: ${failure.kind}`
    );
  }
  if (status.error) {
    lines.push(`Error: ${status.error}`);
  }
  return lines.join("\n");
}

/** The per-kind fields of a connection view. */
export type ConnectionCopy = Pick<
  RemoteConnectionView,
  | "tone"
  | "title"
  | "summary"
  | "shortReason"
  | "meta"
  | "gifTheme"
  | "primaryAction"
  | "showRetry"
  | "sidebarLabel"
  | "pillLabel"
>;

function blockingCopy(
  remote: RemoteHostRecord,
  kind:
    | "identity_changed"
    | "update_required"
    | "auth"
    | "host_key"
    | "protocol",
  fact: string
): ConnectionCopy {
  const { config, status } = remote;
  const name = config.name;
  switch (kind) {
    case "identity_changed":
      return {
        tone: "destructive",
        title: `Check ${name}’s identity`,
        summary:
          "A different machine answered at this address. Syncing is paused so history stays separate — check or re-pair it in Hosts.",
        shortReason: "A different machine answered at this address.",
        meta: `${fact} · Paused`,
        gifTheme: "not-found",
        primaryAction: "open_hosts",
        showRetry: false,
        sidebarLabel: "Identity changed",
        pillLabel: "Check identity",
      };
    case "update_required": {
      if (status.agent_update.kind === "newer_than_this") {
        const version = status.agent_version ? ` ${status.agent_version}` : "";
        return {
          tone: "destructive",
          title: "Update StatGlass on this Mac",
          summary: `${name} is running a newer StatGlass${version}. Update StatGlass on this Mac to resume live readings.`,
          shortReason: `This Mac needs a newer StatGlass to connect to ${name}.`,
          meta: `${fact} · Update required`,
          gifTheme: "coming-soon",
          primaryAction: "open_hosts",
          showRetry: false,
          sidebarLabel: "Update this Mac",
          pillLabel: "Update required",
        };
      }
      const target =
        status.agent_update.kind === "required"
          ? ` ${status.agent_update.target}`
          : "";
      return {
        tone: "destructive",
        title: `${name} needs StatGlass${target}`,
        summary:
          "Its installed StatGlass uses an older protocol. Update it from Hosts to resume live readings.",
        shortReason: `Needs StatGlass${target} to reconnect.`,
        meta: `${fact} · Update required`,
        gifTheme: "coming-soon",
        primaryAction: "open_hosts",
        showRetry: false,
        sidebarLabel: "Update required",
        pillLabel: "Update required",
      };
    }
    case "auth":
      return {
        tone: "destructive",
        title: `SSH couldn’t sign in to ${name}`,
        summary:
          "Key-based SSH access was refused. Unlock your SSH key or check Remote Login settings, then retry.",
        shortReason: "SSH authentication was refused.",
        meta: fact,
        gifTheme: "server-error",
        primaryAction: "retry",
        showRetry: config.enabled,
        sidebarLabel: "Auth failed",
        pillLabel: "Auth failed",
      };
    case "host_key":
      return {
        tone: "destructive",
        title: `Verify ${name}’s SSH host key`,
        summary:
          "SSH couldn’t verify this host’s key. Confirm its fingerprint in Hosts before reconnecting.",
        shortReason: "SSH host key verification needs attention.",
        meta: fact,
        gifTheme: "server-error",
        primaryAction: "open_hosts",
        showRetry: false,
        sidebarLabel: "Verify host key",
        pillLabel: "Verify key",
      };
    case "protocol":
      return {
        tone: "destructive",
        title: `Can’t talk to ${name}`,
        summary:
          "SSH connected, but StatGlass received an unexpected response. Check Technical details or reinstall in Hosts.",
        shortReason: "StatGlass received an unexpected SSH response.",
        meta: fact,
        gifTheme: "server-error",
        primaryAction: "open_hosts",
        showRetry: config.enabled,
        sidebarLabel: "Connection failed",
        pillLabel: "Error",
      };
  }
}

function copyForKind(
  remote: RemoteHostRecord,
  kind: RemoteConnectionKind,
  routes: readonly ConfiguredRoute[],
  fact: string
): ConnectionCopy {
  if (
    kind === "identity_changed" ||
    kind === "update_required" ||
    kind === "auth" ||
    kind === "host_key" ||
    kind === "protocol"
  ) {
    return blockingCopy(remote, kind, fact);
  }
  if (
    kind === "name_not_resolved" ||
    kind === "refused" ||
    kind === "no_route" ||
    kind === "local_offline" ||
    kind === "tailscale_down"
  ) {
    return networkCauseCopy(remote, kind, routes, fact);
  }
  const { config, status, os } = remote;
  const name = config.name;
  const autoRetrying = config.enabled && status.state === "connecting";
  const routeText = routePhrase(routes);

  switch (kind) {
    case "connected":
      return {
        tone: "info",
        title: `${name} is connected`,
        summary: "",
        shortReason: "",
        meta: "",
        gifTheme: null,
        primaryAction: null,
        showRetry: false,
        sidebarLabel: "Live",
        pillLabel: "Live",
      };
    case "connecting":
      return {
        tone: "info",
        title: `Connecting to ${name}…`,
        summary: `Dialing ${routeText}. Live readings will appear once the SSH handshake completes.`,
        shortReason: `Dialing ${routeText}…`,
        meta: fact,
        gifTheme: null,
        primaryAction: "retry",
        showRetry: config.enabled,
        sidebarLabel: "Connecting…",
        pillLabel: "Connecting",
      };
    case "disabled":
      return {
        tone: "info",
        title: `${name} is disconnected`,
        summary:
          "Automatic connection is turned off. Turn it back on to resume live readings.",
        shortReason: "Automatic connection is off.",
        meta: `${fact} · Connection off`,
        gifTheme: null,
        primaryAction: "enable",
        showRetry: false,
        sidebarLabel: "Connection off",
        pillLabel: "Disconnected",
      };
    case "agent_not_running":
      return {
        tone: "warning",
        title: `StatGlass isn’t running on ${name}`,
        summary:
          os === "linux"
            ? "SSH connected, but the StatGlass agent isn’t running. Restart it from Hosts or wait for systemd."
            : `SSH connected, but StatGlass isn’t open on ${name}. Open StatGlass there, then retry.`,
        shortReason:
          os === "linux"
            ? "The StatGlass agent isn’t running on this host."
            : `StatGlass isn’t open on ${name}.`,
        meta: fact,
        gifTheme: "overloaded",
        primaryAction: "retry",
        showRetry: config.enabled,
        sidebarLabel: "Agent stopped",
        pillLabel: "Agent stopped",
      };
    case "app_not_running":
    case "monitoring_off":
      return macMonitoringCopy(remote, kind, fact);
    case "timeout":
      return timeoutCopy(remote, routes, fact);
    case "unreachable":
      return {
        tone: "warning",
        title: `Can’t connect to ${name}`,
        summary: `Couldn’t reach ${routeText}. ${networkHint(routes, name)}`,
        shortReason: `Couldn’t reach ${routeText}.`,
        meta: fact,
        gifTheme: "network-error",
        primaryAction: "retry",
        showRetry: config.enabled,
        sidebarLabel: autoRetrying ? "Reconnecting…" : "Offline",
        pillLabel: "Offline",
      };
  }
}

/**
 * Pure presentation model for a remote host's connection state (ce:handling-errors):
 * names the failing route(s), explains why, surfaces durable history coverage, and
 * picks a `ConnectionGifTheme` (the desktop maps it to `@steamfield/ui`'s `GifTheme`)
 * and the primary recovery action.
 */
export function remoteConnectionView(
  remote: RemoteHostRecord,
  nowMs: number = Date.now()
): RemoteConnectionView {
  const kind = classifyFailure(remote);
  const routes = configuredRoutes(remote.config);
  const fact = historyFact(remote.status, nowMs);
  const copy = copyForKind(remote, kind, routes, fact);
  const syncedThroughMs = remote.status.synced_through_ms;
  return {
    kind,
    ...copy,
    routes,
    routeText: routePhrase(routes),
    syncedThroughMs,
    hasSavedHistory: syncedThroughMs !== null,
    gifSeed: `${remote.config.id}:${kind}`,
    diagnostics: buildDiagnostics(remote, kind, routes),
    routeLines: buildRouteLines(remote.status, routes),
    nextAttemptMs: remote.status.next_attempt_ms,
    dialing: remote.status.dialing,
    waitingForNetwork: remote.status.waiting_for_network,
  };
}

/**
 * The automatic-retry phrase shown after a failing host's status: "Trying…"
 * while an attempt is in flight, else the countdown to the next attempt
 * ("Retrying…" once it reaches zero), else null when nothing is scheduled.
 */
export function retryScheduleText(
  dialing: boolean,
  secondsUntilAttempt: number | null
): string | null {
  if (dialing) return "Trying…";
  if (secondsUntilAttempt === null) return null;
  if (secondsUntilAttempt === 0) return "Retrying…";
  return `Retrying in ${secondsUntilAttempt} s`;
}
