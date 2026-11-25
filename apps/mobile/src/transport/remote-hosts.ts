/**
 * The phone's remote hosts in the shape shared with the mock transport.
 */
import type { MobileRemoteHost } from "@core/generated/types";
import type { PhoneRemoteHostRecord } from "@core/phone-connection";

/** `host` as a `RemoteHostRecord`. */
export function toRemoteHostRecord(
  host: MobileRemoteHost
): PhoneRemoteHostRecord {
  const { id, name, targets, os, connection, ...status } = host;
  const {
    state,
    route,
    sync,
    failure,
    message,
    route_failures,
    incompatible_side,
  } = connection;
  return {
    config: {
      id,
      name,
      lan: targets.find((target) => target.route === "lan")?.host ?? null,
      tailscale:
        targets.find((target) => target.route === "tailscale")?.host ?? null,
      enabled: true,
    },
    os,
    status: {
      ...status,
      state,
      route,
      sync,
      error: message,
      failure_kind: failure,
      incompatible_side,
      route_failures,
      rr: null,
      update: null,
      last_update_failure: null,
      agent_update: { kind: "unknown" },
    },
  };
}
