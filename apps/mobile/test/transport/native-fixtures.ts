import type { MobileRemoteHost } from "@core/generated/types";

export const HOST = "01234567-89ab-cdef-0123-456789abcdef";

export const REMOTE: MobileRemoteHost = {
  id: HOST,
  name: "studio",
  os: "mac_os",
  targets: [
    { route: "lan", host: "studio.local" },
    { route: "tailscale", host: "studio.tail.test" },
  ],
  open_error: null,
  demand: null,
  connection: {
    state: "offline",
    route: "tailscale",
    sync: "idle",
    failure: "timeout",
    incompatible_side: null,
    message: "Timed out",
    route_failures: [{ route: "tailscale", kind: "timeout" }],
  },
  last_seen_ms: 1,
  synced_through_ms: 2,
  next_attempt_ms: 3,
  attempt: 4,
  dialing: false,
  waiting_for_network: true,
  clock_offset_ms: -5,
  vitals: {
    as_of_ms: null,
    cpu_pct: 6,
    memory_pct: 7,
    net_rx_bps: 8,
    net_tx_bps: 9,
    load_1m: 2,
    cores: 12,
    memory_pressure: null,
    disk_used_bytes: 100,
    disk_free_bytes: 200,
    disk_total_bytes: 300,
    disk_low: false,
  },
  agent_version: "1.2.3",
  identity_changed: "ab234567-89ab-cdef-0123-456789abcdef",
};
