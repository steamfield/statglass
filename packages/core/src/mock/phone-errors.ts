import type { CommandError } from "../generated/types";
import type { PhoneRemoteHostStatus } from "../phone-connection";
import { MINUTE_MS } from "../time-grid";
import type { MockTransport } from "./contracts";
import { ok } from "./protocol";
import type { MockRemotes } from "./remote";

export const PHONE_LAST_SEEN_MS = new Date(2026, 10, 24, 14, 2).getTime();
export const PHONE_CLOCK_OFFSET_MS = 2 * MINUTE_MS;

const tailnetTimeout = {
  route: "tailscale",
  kind: "timeout",
} as const;

const failures = {
  "tailscale-down": {
    failure_kind: "tailscale_down",
    route_failures: [{ route: "tailscale", kind: "tailscale_down" }],
  },
  timeout: { failure_kind: "timeout", route_failures: [tailnetTimeout] },
  "name-not-resolved": { failure_kind: "name_not_resolved" },
  refused: { failure_kind: "refused" },
  unreachable: { failure_kind: "no_route" },
  offline: {
    state: "connecting",
    failure_kind: "unreachable",
    last_seen_ms: PHONE_LAST_SEEN_MS,
    clock_offset_ms: PHONE_CLOCK_OFFSET_MS,
  },
  "app-not-running": { failure_kind: "app_not_running" },
  "monitoring-off": { failure_kind: "monitoring_off" },
  "agent-not-running": { failure_kind: "agent_not_running" },
  "identity-changed": { identity_changed: "replacement-id" },
  "no-longer-authorized": {
    failure_kind: "authentication",
    last_seen_ms: PHONE_LAST_SEEN_MS,
  },
  "host-key-changed": { failure_kind: "host_key" },
  "key-not-accepted": { failure_kind: "authentication" },
  "update-host": { failure_kind: "incompatible", incompatible_side: "host" },
  "update-app": { failure_kind: "incompatible", incompatible_side: "app" },
  incompatible: { failure_kind: "incompatible" },
  "local-offline": { waiting_for_network: true },
  "phone-key-unavailable": { failure_kind: "phone_key_unavailable" },
  "open-error": {
    open_error: { kind: "invalid_argument", message: "Invalid SSH endpoint" },
  },
  "open-signer-error": {
    open_error: { kind: "internal", message: "Signer unavailable" },
  },
  protocol: { state: "connecting", failure_kind: "protocol" },
  internal: { failure_kind: "internal" },
} satisfies Record<string, Partial<PhoneRemoteHostStatus>>;

export function seedPhoneErrors(remotes: MockRemotes): void {
  for (const [name, status] of Object.entries(failures)) {
    const tailscale =
      name === "timeout" || name === "tailscale-down" ? name : null;
    const linux = name === "agent-not-running";
    const record = remotes.addRemote(
      {
        id: `phone-${name}`,
        name,
        lan: `${name}.local`,
        tailscale,
        enabled: true,
        mirror_budget_mb: 0,
      },
      linux ? ["linux"] : undefined
    );
    const nextAttemptMs =
      name === "agent-not-running"
        ? (record.status.last_seen_ms ?? Date.now()) + 3 * MINUTE_MS
        : null;
    // Keep the sample vitals to exercise the UI's handling of a stale reply.
    record.status = {
      ...record.status,
      state: "error",
      route: null,
      last_seen_ms: null,
      synced_through_ms: null,
      error: "Mock connection diagnostic",
      ...status,
      ...(nextAttemptMs === null
        ? {}
        : { state: "connecting", next_attempt_ms: nextAttemptMs }),
    };
  }
}

export const phoneCommandFailures = {
  status: { kind: "remote_unreachable", message: "Network unavailable" },
  registry: { kind: "internal", message: "Host registry unavailable." },
  statusEndpoint: { kind: "internal", message: "Status endpoint unavailable." },
  retryTimeout: { kind: "remote_unreachable", message: "The host timed out." },
  retryNetwork: {
    kind: "remote_unreachable",
    message: "The network is unreachable.",
  },
  transientNetwork: {
    kind: "remote_unreachable",
    message: "Network unavailable",
  },
  networkChanged: { kind: "remote_unreachable", message: "Network changed" },
  revokedKey: { kind: "remote_auth", message: "SSH rejected this key." },
} satisfies Record<string, CommandError>;

/** Scoped CPU reply with a missing minute for hosts-list tests. */
export const phoneSparklineFixture: MockTransport["hostHistory"] = async (
  request
) =>
  ok({
    tier: "m1",
    bucket_ms: MINUTE_MS,
    complete_to_ms: request.to_ms ?? request.from_ms,
    gaps: [],
    events: [],
    stats: [],
    clamped: [],
    series: [
      {
        key: { metric: "cpu.total", labels: [] },
        hold_ms: MINUTE_MS,
        points: [
          { t: request.from_ms, min: 11, max: 13, avg: 12 },
          { t: request.from_ms + 2 * MINUTE_MS, min: 15, max: 17, avg: 16 },
        ],
      },
    ],
  });
