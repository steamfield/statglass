import type { RemoteHostRecord } from "@core/generated/types";
import { mockHostVitals } from "@core/mock/remote-updates";
import { remoteConnectionView } from "./remote-connection";

const NOW = 1_795_000_000_000;

function remote(status: Partial<RemoteHostRecord["status"]>): RemoteHostRecord {
  return {
    config: {
      id: "studio",
      name: "Studio",
      lan: "studio.local",
      tailscale: null,
      enabled: true,
      mirror_budget_mb: 100,
    },
    os: "mac_os",
    status: {
      state: "connecting",
      route: null,
      last_seen_ms: NOW - 60_000,
      synced_through_ms: null,
      error: "studio.local: Operation timed out",
      failure_kind: "timeout",
      route_failures: [{ route: "lan", kind: "timeout" }],
      next_attempt_ms: null,
      attempt: 0,
      dialing: false,
      waiting_for_network: false,
      sync: "idle",
      clock_offset_ms: 0,
      agent_version: "0.12.1",
      agent_update: { kind: "up_to_date", installed: "0.12.1" },
      identity_changed: null,
      rr: null,
      vitals: mockHostVitals(false),
      update: null,
      last_update_failure: null,
      ...status,
    },
  };
}

describe("remoteConnectionView retry fields", () => {
  it("passes the next attempt time through for the countdown", () => {
    const view = remoteConnectionView(
      remote({ next_attempt_ms: NOW + 12_000, attempt: 3 }),
      NOW
    );
    expect(view.nextAttemptMs).toBe(NOW + 12_000);
    expect(view.dialing).toBe(false);
    expect(view.waitingForNetwork).toBe(false);
  });

  it("reports an attempt in flight", () => {
    const view = remoteConnectionView(remote({ dialing: true }), NOW);
    expect(view.dialing).toBe(true);
    expect(view.nextAttemptMs).toBeNull();
  });

  it("reports waiting for the network", () => {
    const view = remoteConnectionView(
      remote({
        failure_kind: "local_offline",
        route_failures: [{ route: "lan", kind: "local_offline" }],
        waiting_for_network: true,
      }),
      NOW
    );
    expect(view.waitingForNetwork).toBe(true);
    expect(view.kind).toBe("local_offline");
  });

  it("drops the auto-retrying suffix now that the countdown says it", () => {
    const view = remoteConnectionView(
      remote({ next_attempt_ms: NOW + 4_000 }),
      NOW
    );
    expect(view.meta).toBe("Last seen 1 min ago");
  });
});
