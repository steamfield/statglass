import type { RemoteHostRecord } from "@core/generated/types";
import { mockHostVitals } from "@core/mock/remote-updates";
import { remoteConnectionView } from "./remote-connection";

function makeRemote(
  overrides: Partial<RemoteHostRecord["status"]> = {},
  configOverrides: Partial<RemoteHostRecord["config"]> = {},
  os: RemoteHostRecord["os"] = "mac_os"
): RemoteHostRecord {
  return {
    config: {
      id: "m4-mini",
      name: "M4 Mini",
      lan: "m4-mini.local",
      tailscale: "m4-mini-ts",
      enabled: true,
      mirror_budget_mb: 100,
      ...configOverrides,
    },
    os,
    status: {
      state: "connecting",
      route: null,
      last_seen_ms: null,
      synced_through_ms: null,
      error: null,
      failure_kind: null,
      route_failures: [],
      next_attempt_ms: null,
      attempt: 0,
      dialing: false,
      waiting_for_network: false,
      sync: "idle",
      clock_offset_ms: 0,
      agent_version: "0.12.0",
      agent_update: { kind: "up_to_date", installed: "0.12.0" },
      identity_changed: null,
      rr: null,
      vitals: mockHostVitals(false),
      update: null,
      last_update_failure: null,
      ...overrides,
    },
  };
}

describe("remoteConnectionView", () => {
  const now = 1_795_000_000_000;

  it("diagnoses dual-route Tailscale + LAN timeout with durable history after restart", () => {
    const view = remoteConnectionView(
      makeRemote({
        state: "connecting",
        failure_kind: "timeout",
        last_seen_ms: null,
        synced_through_ms: now - 54 * 60_000,
        error: "LAN: dns failed; Tailscale: Operation timed out",
      }),
      now
    );
    expect(view.kind).toBe("timeout");
    expect(view.tone).toBe("warning");
    expect(view.gifTheme).toBe("timeout");
    expect(view.hasSavedHistory).toBe(true);
    expect(view.summary).toContain("LAN (m4-mini.local)");
    expect(view.summary).toContain("Tailscale (m4-mini-ts)");
    expect(view.meta).toContain("Saved history through");
    expect(view.meta).not.toContain("Never connected");
    expect(view.meta).not.toContain("Auto-retrying");
    expect(view.primaryAction).toBe("retry");
    expect(view.diagnostics).toContain("Tailscale=m4-mini-ts");
  });

  it("reports never connected only when both last_seen_ms and synced_through_ms are null", () => {
    const view = remoteConnectionView(
      makeRemote(
        {
          state: "error",
          failure_kind: "unreachable",
          error: "ssh: Could not resolve hostname",
        },
        { lan: null, tailscale: "m4-mini-ts" }
      ),
      now
    );
    expect(view.kind).toBe("unreachable");
    expect(view.hasSavedHistory).toBe(false);
    expect(view.meta).toBe("Never connected");
    expect(view.gifTheme).toBe("network-error");
    expect(view.summary).toContain("Tailscale (m4-mini-ts)");
  });

  it("keeps calm initial connecting free of error GIFs", () => {
    const view = remoteConnectionView(makeRemote({ state: "connecting" }), now);
    expect(view.kind).toBe("connecting");
    expect(view.gifTheme).toBeNull();
    expect(view.tone).toBe("info");
  });

  it("routes blocking states (host_key, identity_changed, update_required) to open_hosts", () => {
    const hostKey = remoteConnectionView(
      makeRemote({
        state: "error",
        failure_kind: "host_key",
        error: "Host key changed",
      }),
      now
    );
    expect(hostKey.kind).toBe("host_key");
    expect(hostKey.primaryAction).toBe("open_hosts");
    expect(hostKey.showRetry).toBe(false);

    const identity = remoteConnectionView(
      makeRemote({ state: "error", identity_changed: "other-id" }),
      now
    );
    expect(identity.kind).toBe("identity_changed");
    expect(identity.gifTheme).toBe("not-found");
    expect(identity.primaryAction).toBe("open_hosts");

    const update = remoteConnectionView(
      makeRemote({
        state: "error",
        agent_update: {
          kind: "required",
          installed: "0.1.0",
          target: "0.12.0",
        },
      }),
      now
    );
    expect(update.kind).toBe("update_required");
    expect(update.title).toContain("0.12.0");
    expect(update.primaryAction).toBe("open_hosts");

    const newer = remoteConnectionView(
      makeRemote({
        state: "error",
        failure_kind: "incompatible",
        agent_version: "2.0.0",
        agent_update: { kind: "newer_than_this", installed: "2.0.0" },
      }),
      now
    );
    expect(newer.kind).toBe("update_required");
    expect(newer.title).toBe("Update StatGlass on this Mac");
    expect(newer.summary).toContain("2.0.0");

    const reconnecting = remoteConnectionView(
      makeRemote({
        state: "connecting",
        failure_kind: null,
        error: "Remote history is disabled or unavailable",
      }),
      now
    );
    expect(reconnecting.kind).toBe("connecting");
    expect(reconnecting.gifTheme).toBeNull();
  });

  it("offers direct enable action when disabled and tailored copy for Linux vs Mac agent stopped", () => {
    const disabled = remoteConnectionView(
      makeRemote({ state: "disabled" }, { enabled: false }),
      now
    );
    expect(disabled.kind).toBe("disabled");
    expect(disabled.primaryAction).toBe("enable");
    expect(disabled.gifTheme).toBeNull();

    const linuxStopped = remoteConnectionView(
      makeRemote(
        { state: "connecting", failure_kind: "agent_not_running" },
        {},
        "linux"
      ),
      now
    );
    expect(linuxStopped.summary).toContain("systemd");
    expect(linuxStopped.gifTheme).toBe("overloaded");

    const macStopped = remoteConnectionView(
      makeRemote(
        { state: "connecting", failure_kind: "agent_not_running" },
        {},
        "mac_os"
      ),
      now
    );
    expect(macStopped.summary).toContain("Open StatGlass");
  });
});
