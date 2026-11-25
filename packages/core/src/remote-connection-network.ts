/**
 * Wording for connection failures caused by the network path: which route failed
 * and why, what to do about it, and the shared retry behavior of those cards.
 * Pure functions from a host record to copy; `remote-connection.ts` picks which apply.
 */
import type {
  RemoteFailureKind,
  RemoteHostRecord,
  RemoteRouteFailure,
} from "@core/generated/types";
import type { ConfiguredRoute, ConnectionCopy } from "./remote-connection";

/** The configured routes as one phrase for copy: both routes joined by "or", the only route, or "the saved SSH route" when none is set. */
export function routePhrase(routes: readonly ConfiguredRoute[]): string {
  if (routes.length === 2) {
    const [lan, ts] = routes;
    return `LAN (${lan?.alias}) or Tailscale (${ts?.alias})`;
  }
  const only = routes[0];
  if (!only) return "the saved SSH route";
  return `${only.label} (${only.alias})`;
}

/** What to check when the network path failed, worded for the kinds of route configured. */
export function networkHint(
  routes: readonly ConfiguredRoute[],
  name: string
): string {
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

const ROUTE_FAILURE_REASONS: Partial<Record<RemoteFailureKind, string>> = {
  name_not_resolved: "name not found on this network",
  refused: "SSH refused the connection",
  no_route: "no route from this Mac",
  timeout: "didn’t answer in time",
  tailscale_down: "Tailscale is off on this Mac",
  local_offline: "this Mac is offline",
  unreachable: "couldn’t connect",
  agent_not_running: "StatGlass isn’t running there",
  app_not_running: "StatGlass isn't running there",
  monitoring_off: "Remote monitoring is off there",
};

const UNKNOWN_ROUTE_FAILURE_REASON = "connection failed";

/** One "<Label> (<alias>): <reason>" line per failed route; empty while connected. */
export function buildRouteLines(
  status: RemoteHostRecord["status"],
  routes: readonly ConfiguredRoute[]
): string[] {
  if (status.state === "connected") return [];
  return status.route_failures.flatMap((failure) => {
    const route = routes.find((r) => r.kind === failure.route);
    if (!route) return [];
    const reason =
      ROUTE_FAILURE_REASONS[failure.kind] ?? UNKNOWN_ROUTE_FAILURE_REASON;
    return [`${route.label} (${route.alias}): ${reason}`];
  });
}

/**
 * The configured route that carries `kind` in the route failures, falling back
 * to the first configured route.
 */
function routeFor(
  status: RemoteHostRecord["status"],
  routes: readonly ConfiguredRoute[],
  kind: RemoteFailureKind
): ConfiguredRoute | undefined {
  const failure = status.route_failures.find((f) => f.kind === kind);
  return routes.find((r) => r.kind === failure?.route) ?? routes[0];
}

function hasRouteFailure(
  failures: readonly RemoteRouteFailure[],
  route: RemoteRouteFailure["route"],
  kind: RemoteFailureKind
): boolean {
  return failures.some((f) => f.route === route && f.kind === kind);
}

/** Failure kinds whose copy blames the network path. */
export type NetworkCauseKind =
  | "name_not_resolved"
  | "refused"
  | "no_route"
  | "local_offline"
  | "tailscale_down";

type CauseWording = Pick<
  ConnectionCopy,
  "title" | "summary" | "shortReason" | "gifTheme"
> & { readonly label: string };

function cannotFindWording(
  remote: RemoteHostRecord,
  routes: readonly ConfiguredRoute[]
): CauseWording {
  const name = remote.config.name;
  const route = routeFor(remote.status, routes, "name_not_resolved");
  const alias = route?.alias ?? "";
  const summary =
    route?.kind === "tailscale"
      ? `Tailscale couldn’t find ${alias}. Check the name in host settings.`
      : `${alias} didn’t resolve on this network. If you’re away from ${name}’s network, add a Tailscale address in host settings.`;
  return {
    title: `Can’t find ${name}`,
    summary,
    shortReason: `${alias} wasn’t found.`,
    gifTheme: "not-found",
    label: "Not found",
  };
}

function refusedWording(remote: RemoteHostRecord): CauseWording {
  const name = remote.config.name;
  const fix =
    remote.os === "linux"
      ? `Start sshd on ${name}.`
      : `Turn on Remote Login in System Settings › General › Sharing on ${name}.`;
  return {
    title: `${name} refused SSH`,
    summary: `${name} answered but isn’t accepting SSH. ${fix}`,
    shortReason: "SSH connection refused.",
    gifTheme: "server-error",
    label: "SSH refused",
  };
}

function noRouteWording(
  remote: RemoteHostRecord,
  routes: readonly ConfiguredRoute[]
): CauseWording {
  const name = remote.config.name;
  return {
    title: `Can’t reach ${name}`,
    summary: `This Mac has no route to ${routePhrase(routes)}. ${networkHint(routes, name)}`,
    shortReason: `No route to ${name}.`,
    gifTheme: "network-error",
    label: "No route",
  };
}

function localOfflineWording(remote: RemoteHostRecord): CauseWording {
  return {
    title: "This Mac is offline",
    summary: `StatGlass will reconnect to ${remote.config.name} when this Mac is back online. Saved history stays available.`,
    shortReason: "This Mac is offline.",
    gifTheme: "network-error",
    label: "Waiting for network",
  };
}

function tailscaleDownWording(
  remote: RemoteHostRecord,
  routes: readonly ConfiguredRoute[]
): CauseWording {
  const name = remote.config.name;
  const alias = routeFor(remote.status, routes, "tailscale_down")?.alias ?? "";
  const summary = routes.some((r) => r.kind === "lan")
    ? `${name} isn’t reachable on this network, and Tailscale is off on this Mac. Turn on Tailscale to reconnect.`
    : `${name} connects over Tailscale (${alias}). Turn on Tailscale on this Mac to reconnect.`;
  return {
    title: "Tailscale is off on this Mac",
    summary,
    shortReason: "Tailscale is off on this Mac.",
    gifTheme: "network-error",
    label: "Tailscale off",
  };
}

function causeWording(
  remote: RemoteHostRecord,
  kind: NetworkCauseKind,
  routes: readonly ConfiguredRoute[]
): CauseWording {
  switch (kind) {
    case "name_not_resolved":
      return cannotFindWording(remote, routes);
    case "refused":
      return refusedWording(remote);
    case "no_route":
      return noRouteWording(remote, routes);
    case "local_offline":
      return localOfflineWording(remote);
    case "tailscale_down":
      return tailscaleDownWording(remote, routes);
  }
}

/** Copy for a failure whose cause is the network path, with the shared retry behavior. */
export function networkCauseCopy(
  remote: RemoteHostRecord,
  kind: NetworkCauseKind,
  routes: readonly ConfiguredRoute[],
  fact: string
): ConnectionCopy {
  const { config, status } = remote;
  const { label, ...wording } = causeWording(remote, kind, routes);
  const autoRetrying = config.enabled && status.state === "connecting";
  return {
    ...wording,
    tone: "warning",
    meta: fact,
    primaryAction: "retry",
    showRetry: config.enabled,
    sidebarLabel: autoRetrying ? "Reconnecting…" : label,
    pillLabel: "Offline",
  };
}

/** A Tailscale route that timed out while the LAN route was not refused: the peer is silent. */
function isSilentTailscalePeer(status: RemoteHostRecord["status"]): boolean {
  const failures = status.route_failures;
  return (
    hasRouteFailure(failures, "tailscale", "timeout") &&
    !hasRouteFailure(failures, "lan", "refused")
  );
}

function silentPeerWording(
  remote: RemoteHostRecord,
  routes: readonly ConfiguredRoute[]
): Pick<ConnectionCopy, "title" | "summary" | "shortReason"> {
  const name = remote.config.name;
  const alias = routes.find((r) => r.kind === "tailscale")?.alias ?? "";
  return {
    title: `${name} isn’t responding`,
    summary: `Tailscale is on, but ${name} didn’t answer at ${alias}. It may be asleep, shut down or signed out of Tailscale.`,
    shortReason: "Not responding on Tailscale.",
  };
}

/**
 * Copy for a connection attempt that timed out on every route. When the Tailscale
 * route timed out and the LAN route wasn't refused (a silent Tailscale peer), the
 * title, summary and short reason say the peer isn't responding instead.
 */
export function timeoutCopy(
  remote: RemoteHostRecord,
  routes: readonly ConfiguredRoute[],
  fact: string
): ConnectionCopy {
  const { config, status } = remote;
  const routeText = routePhrase(routes);
  const autoRetrying = config.enabled && status.state === "connecting";
  return {
    tone: "warning",
    title: `Can’t connect to ${config.name}`,
    summary: `${routeText} timed out. ${networkHint(routes, config.name)}`,
    shortReason: `${routeText} timed out.`,
    ...(isSilentTailscalePeer(status) ? silentPeerWording(remote, routes) : {}),
    meta: fact,
    gifTheme: "timeout",
    primaryAction: "retry",
    showRetry: config.enabled,
    sidebarLabel: autoRetrying ? "Reconnecting…" : "Timed out",
    pillLabel: "Offline",
  };
}
