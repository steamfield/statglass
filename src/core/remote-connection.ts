import { formatDateTime } from "@core/format";
import type {
  RemoteFailureKind,
  RemoteHostRecord,
} from "@core/generated/bindings";
import type { GifTheme } from "@steamfield/ui/gif";

export type RemoteConnectionKind =
  | "connected"
  | "connecting"
  | "unreachable"
  | "timeout"
  | "auth"
  | "host_key"
  | "agent_not_running"
  | "update_required"
  | "identity_changed"
  | "disabled"
  | "protocol";

export type RemoteConnectionTone = "info" | "warning" | "destructive";

export type RemotePrimaryAction = "retry" | "enable" | "open_hosts";

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
  /** Durable mirrored history watermark (remote host clock epoch ms), or null when none. */
  readonly syncedThroughMs: number | null;
  readonly hasSavedHistory: boolean;
  readonly gifTheme: GifTheme | null;
  readonly gifSeed: string;
  readonly primaryAction: RemotePrimaryAction | null;
  readonly showRetry: boolean;
  readonly diagnostics: string;
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

function routePhrase(routes: readonly ConfiguredRoute[]): string {
  if (routes.length === 2) {
    const [lan, ts] = routes;
    return `LAN (${lan?.alias}) or Tailscale (${ts?.alias})`;
  }
  const only = routes[0];
  if (!only) return "the saved SSH route";
  return `${only.label} (${only.alias})`;
}

function networkHint(routes: readonly ConfiguredRoute[], name: string): string {
  const hasLan = routes.some((r) => r.kind === "lan");
  const hasTs = routes.some((r) => r.kind === "tailscale");
  if (hasLan && hasTs) {
    return `Check your network or Tailscale connection, and confirm ${name} is awake.`;
  }
  if (hasTs) {
    return `Check that Tailscale is connected and ${name} is awake.`;
  }
  if (hasLan) {
    return `Check that both machines are on the same network and ${name} is awake.`;
  }
  return `Check the SSH address in Hosts and confirm ${name} is awake.`;
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
  if (status.error) {
    lines.push(`Error: ${status.error}`);
  }
  return lines.join("\n");
}

type ConnectionCopy = Pick<
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
  const { config, status, os } = remote;
  const name = config.name;
  const autoRetrying = config.enabled && status.state === "connecting";
  const retryTag = autoRetrying ? " · Auto-retrying" : "";
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
        meta: `${fact}${retryTag}`,
        gifTheme: "overloaded",
        primaryAction: "retry",
        showRetry: config.enabled,
        sidebarLabel: "Agent stopped",
        pillLabel: "Agent stopped",
      };
    case "timeout":
      return {
        tone: "warning",
        title: `Can’t connect to ${name}`,
        summary: `${routeText} timed out. ${networkHint(routes, name)}`,
        shortReason: `${routeText} timed out.`,
        meta: `${fact}${retryTag}`,
        gifTheme: "timeout",
        primaryAction: "retry",
        showRetry: config.enabled,
        sidebarLabel: autoRetrying ? "Reconnecting…" : "Timed out",
        pillLabel: "Offline",
      };
    case "unreachable":
      return {
        tone: "warning",
        title: `Can’t connect to ${name}`,
        summary: `Couldn’t reach ${routeText}. ${networkHint(routes, name)}`,
        shortReason: `Couldn’t reach ${routeText}.`,
        meta: `${fact}${retryTag}`,
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
 * picks the contextual `@steamfield/ui/gif` theme and primary recovery action.
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
    syncedThroughMs,
    hasSavedHistory: syncedThroughMs !== null,
    gifSeed: `${remote.config.id}:${kind}`,
    diagnostics: buildDiagnostics(remote, kind, routes),
  };
}
