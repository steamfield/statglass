/**
 * Mock scenarios for remote hosts that fail on the network path: an unresolvable
 * name, a refused SSH connection, Tailscale off or silent, and this Mac offline.
 * Each seeds hosts whose status matches what Rust reports for that cause.
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
}

/** Puts every remote host into local_offline: this Mac has no network, so no route can answer. */
export function seedMacOffline(remotes: MockRemotes) {
  for (const { record } of remotes.remotes.values()) {
    const { config, status } = record;
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
    };
  }
}

const NETWORK_CAUSE_HOSTS: readonly (readonly [ScenarioName, string])[] = [
  ["host-name-not-resolved", "remote-name-not-resolved"],
  ["host-refused", "remote-refused"],
  ["host-tailscale-down", "remote-tailscale-down"],
  ["host-tailscale-silent", "remote-tailscale-silent"],
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
