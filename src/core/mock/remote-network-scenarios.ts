/**
 * Mock scenarios for remote hosts that fail on the network path: an unresolvable
 * name, a refused SSH connection, Tailscale off or silent, a host retrying on a
 * growing backoff, and this Mac offline. Each seeds hosts whose status matches
 * what Rust reports for that cause.
 */
import type {
  HostVitals,
  RemoteHostStatus,
  RemoteRouteFailure,
} from "@core/generated/bindings";
import type { ScenarioName } from "./fixtures";
import type { MockRemotes } from "./remote";

const NO_READINGS: Omit<HostVitals, "cores"> = {
  cpu_pct: null,
  memory_pct: null,
  load_1m: null,
  memory_pressure: null,
  disk_used_bytes: null,
  disk_free_bytes: null,
  disk_total_bytes: null,
  disk_low: false,
  net_rx_bps: null,
  net_tx_bps: null,
};

const DEFAULT_CORES = 10;

/** A connecting host that has never answered: no readings, only the failure. */
function failedConnection(
  failure: Pick<RemoteHostStatus, "failure_kind" | "error">,
  routeFailures: RemoteRouteFailure[],
  cores: number
): Partial<RemoteHostStatus> {
  return {
    state: "connecting",
    route: null,
    last_seen_ms: null,
    synced_through_ms: null,
    ...failure,
    route_failures: routeFailures,
    vitals: { cores, ...NO_READINGS },
    clock_offset_ms: null,
  };
}

/** Adds a Mac host `remote-<name>` reachable on LAN, and on Tailscale when `dualRoute`. */
function seedFailingHost(
  remotes: MockRemotes,
  name: string,
  dualRoute: boolean,
  status: Partial<RemoteHostStatus>
) {
  const record = remotes.addRemote(
    {
      id: `remote-${name}`,
      name,
      lan: `${name}.local`,
      tailscale: dualRoute ? `${name}-ts` : null,
      enabled: true,
      mirror_budget_mb: 100,
    },
    ["no-battery", "no-fans"]
  );
  record.status = { ...record.status, ...status };
}

/** Hosts that fail on the network path, one per specific cause. */
export function seedNetworkCauseHosts(
  remotes: MockRemotes,
  scenarios: readonly ScenarioName[]
) {
  if (scenarios.includes("host-name-not-resolved"))
    seedFailingHost(
      remotes,
      "name-not-resolved",
      false,
      failedConnection(
        {
          failure_kind: "name_not_resolved",
          error:
            "ssh: Could not resolve hostname name-not-resolved.local: nodename nor servname provided, or not known",
        },
        [{ route: "lan", kind: "name_not_resolved" }],
        DEFAULT_CORES
      )
    );
  if (scenarios.includes("host-refused"))
    seedFailingHost(
      remotes,
      "refused",
      false,
      failedConnection(
        {
          failure_kind: "refused",
          error:
            "ssh: connect to host refused.local port 22: Connection refused",
        },
        [{ route: "lan", kind: "refused" }],
        DEFAULT_CORES
      )
    );
  if (scenarios.includes("host-tailscale-down"))
    seedFailingHost(
      remotes,
      "tailscale-down",
      true,
      failedConnection(
        {
          failure_kind: "tailscale_down",
          error:
            "ssh: Could not resolve hostname tailscale-down-ts: Tailscale is not running",
        },
        [
          { route: "lan", kind: "name_not_resolved" },
          { route: "tailscale", kind: "tailscale_down" },
        ],
        DEFAULT_CORES
      )
    );
  if (scenarios.includes("host-tailscale-silent"))
    seedFailingHost(
      remotes,
      "tailscale-silent",
      true,
      failedConnection(
        {
          failure_kind: "timeout",
          error:
            "ssh: connect to host tailscale-silent-ts port 22: Operation timed out",
        },
        [
          { route: "lan", kind: "name_not_resolved" },
          { route: "tailscale", kind: "timeout" },
        ],
        DEFAULT_CORES
      )
    );
  if (scenarios.includes("host-backoff")) seedBackoffHost(remotes);
}

const BACKOFF_HOST_ID = "remote-backoff";
const BACKOFF_FIRST_WAIT_MS = 12_000;
const BACKOFF_MAX_WAIT_MS = 60_000;
const DIAL_MS = 1_500;

/** The pending timer of each backoff host and the wait it is counting down. */
const backoffTimers = new WeakMap<
  MockRemotes,
  Map<string, { timer: ReturnType<typeof setTimeout>; waitMs: number }>
>();

/** The backoff timers of one mock transport's remotes. */
function timersFor(remotes: MockRemotes) {
  let timers = backoffTimers.get(remotes);
  if (!timers) {
    timers = new Map();
    backoffTimers.set(remotes, timers);
  }
  return timers;
}

/** Applies `status` to a host and tells listeners, as Rust re-emits a changed schedule. */
function publish(
  remotes: MockRemotes,
  id: string,
  status: Partial<RemoteHostStatus>
): boolean {
  const remote = remotes.remotes.get(id);
  if (!remote) return false;
  remote.record = {
    ...remote.record,
    status: { ...remote.record.status, ...status },
  };
  remotes.emitHostsChanged();
  return true;
}

/** Fails the attempt in flight and schedules the next one after `waitMs` (this Mac's clock). */
function failAttempt(remotes: MockRemotes, id: string, waitMs: number) {
  const attempt = (remotes.remotes.get(id)?.record.status.attempt ?? 0) + 1;
  const scheduled = publish(remotes, id, {
    dialing: false,
    attempt,
    next_attempt_ms: Date.now() + waitMs,
  });
  if (!scheduled) return;
  const timer = setTimeout(() => dialBackoffHost(remotes, id), waitMs);
  timersFor(remotes).set(id, { timer, waitMs });
}

/** Starts an attempt now: dialing for a moment, then failing again with the wait doubled. */
function dialBackoffHost(remotes: MockRemotes, id: string) {
  const timers = timersFor(remotes);
  const pending = timers.get(id);
  if (!pending || remotes.remotes.get(id)?.record.status.dialing) return;
  clearTimeout(pending.timer);
  if (!publish(remotes, id, { dialing: true, next_attempt_ms: null })) return;
  const nextWaitMs = Math.min(pending.waitMs * 2, BACKOFF_MAX_WAIT_MS);
  const timer = setTimeout(() => failAttempt(remotes, id, nextWaitMs), DIAL_MS);
  timers.set(id, { timer, waitMs: pending.waitMs });
}

/** A host that keeps timing out, three attempts in with the next one 12 s away. */
function seedBackoffHost(remotes: MockRemotes) {
  seedFailingHost(remotes, "backoff", false, {
    ...failedConnection(
      {
        failure_kind: "timeout",
        error:
          "ssh: connect to host backoff.local port 22: Operation timed out",
      },
      [{ route: "lan", kind: "timeout" }],
      DEFAULT_CORES
    ),
    attempt: 2,
  });
  failAttempt(remotes, BACKOFF_HOST_ID, BACKOFF_FIRST_WAIT_MS);
}

/**
 * A manual retry of the host-backoff host: cuts the wait and dials now. Returns
 * false for any other host so the caller handles it as usual.
 */
export function retryBackoffHost(remotes: MockRemotes, id: string): boolean {
  if (id !== BACKOFF_HOST_ID || !timersFor(remotes).has(id)) return false;
  dialBackoffHost(remotes, id);
  return true;
}

/**
 * Puts every enabled remote host into local_offline and waiting for the network:
 * this Mac has no network, so no route can answer. Hosts with connections
 * turned off stay as they are, since Rust never dials them.
 */
export function seedMacOffline(remotes: MockRemotes) {
  for (const { record } of remotes.remotes.values()) {
    const { config, status } = record;
    if (!config.enabled) continue;
    const routeFailures: RemoteRouteFailure[] = [];
    if (config.lan) routeFailures.push({ route: "lan", kind: "local_offline" });
    if (config.tailscale)
      routeFailures.push({ route: "tailscale", kind: "local_offline" });
    record.status = {
      ...status,
      ...failedConnection(
        {
          failure_kind: "local_offline",
          error: `ssh: connect to host ${config.lan ?? config.tailscale} port 22: Network is down`,
        },
        routeFailures,
        status.vitals?.cores ?? DEFAULT_CORES
      ),
      last_seen_ms: status.last_seen_ms,
      synced_through_ms: status.synced_through_ms,
      next_attempt_ms: null,
      dialing: false,
      waiting_for_network: true,
    };
  }
}

const NETWORK_CAUSE_HOSTS: readonly (readonly [ScenarioName, string])[] = [
  ["host-name-not-resolved", "remote-name-not-resolved"],
  ["host-refused", "remote-refused"],
  ["host-tailscale-down", "remote-tailscale-down"],
  ["host-tailscale-silent", "remote-tailscale-silent"],
  ["host-backoff", BACKOFF_HOST_ID],
];

/** True when the mock keeps `hostId` failing: these scenarios model a cause a retry or stream can't fix. */
export function staysFailing(
  scenarios: readonly ScenarioName[],
  hostId: string
): boolean {
  if (scenarios.includes("mac-offline")) return true;
  return NETWORK_CAUSE_HOSTS.some(
    ([scenario, id]) => scenarios.includes(scenario) && id === hostId
  );
}
