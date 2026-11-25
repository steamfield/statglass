/**
 * The phone's remote hosts in the desktop's `RemoteHostRecord` shape, which
 * the phone's screens and the mock transport share. Fields only a Mac
 * controller has (remote runs, agent updates) get their "none" values.
 */
import type { MobileRemoteHost, RemoteHostRecord } from "@core/generated/types";

/** `host` as a `RemoteHostRecord`. */
export function toRemoteHostRecord(host: MobileRemoteHost): RemoteHostRecord {
  const { id, name, targets, mirror_budget_mb, os, connection, ...status } =
    host;
  const { state, route, sync, failure, message, route_failures } = connection;
  return {
    config: {
      id,
      name,
      lan: targets.find((target) => target.route === "lan")?.host ?? null,
      tailscale:
        targets.find((target) => target.route === "tailscale")?.host ?? null,
      enabled: true,
      mirror_budget_mb,
    },
    os,
    status: {
      ...status,
      state,
      route,
      sync,
      error: message,
      failure_kind: failure,
      route_failures,
      rr: null,
      update: null,
      last_update_failure: null,
      agent_update: { kind: "unknown" },
    },
  };
}
