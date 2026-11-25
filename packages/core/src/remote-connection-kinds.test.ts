import type {
  RemoteFailureKind,
  RemoteHostRecord,
  RemoteRouteFailure,
} from "@core/generated/types";
import { mockHostVitals } from "@core/mock/remote-updates";
import { remoteConnectionView } from "./remote-connection";

const NOW = 1_795_000_000_000;

function failing(
  failure_kind: RemoteFailureKind,
  route_failures: RemoteRouteFailure[],
  config: Partial<RemoteHostRecord["config"]> = {},
  os: RemoteHostRecord["os"] = "mac_os"
): RemoteHostRecord {
  return {
    config: {
      id: "studio",
      name: "Studio",
      lan: "studio.local",
      tailscale: "studio-ts",
      enabled: true,
      mirror_budget_mb: 100,
      ...config,
    },
    os,
    status: {
      state: "connecting",
      route: null,
      last_seen_ms: NOW - 5 * 60_000,
      synced_through_ms: null,
      error: "LAN: studio.local: ssh failed; Tailscale: studio-ts: ssh failed",
      failure_kind,
      route_failures,
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
    },
  };
}

const view = (remote: RemoteHostRecord) => remoteConnectionView(remote, NOW);

describe("remoteConnectionView for network causes", () => {
  it.each<[RemoteFailureKind, string]>([
    ["name_not_resolved", "name_not_resolved"],
    ["refused", "refused"],
    ["no_route", "no_route"],
    ["local_offline", "local_offline"],
    ["tailscale_down", "tailscale_down"],
  ])("maps %s to its own view kind with a retry", (failure, kind) => {
    const v = view(
      failing(failure, [{ route: "tailscale", kind: failure }], { lan: null })
    );
    expect(v.kind).toBe(kind);
    expect(v.tone).toBe("warning");
    expect(v.primaryAction).toBe("retry");
    expect(v.showRetry).toBe(true);
    expect(v.meta).not.toContain("Auto-retrying");
  });

  it("says this Mac is offline instead of blaming the host", () => {
    const v = view(
      failing("local_offline", [
        { route: "lan", kind: "local_offline" },
        { route: "tailscale", kind: "local_offline" },
      ])
    );
    expect(v.title).toBe("This Mac is offline");
    expect(v.summary).toBe(
      "StatGlass will reconnect to Studio when this Mac is back online. Saved history stays available."
    );
    expect(v.shortReason).toBe("This Mac is offline.");
    expect(v.sidebarLabel).toBe("Reconnecting…");
  });

  it("asks to turn on Tailscale for a Tailscale-only host", () => {
    const v = view(
      failing(
        "tailscale_down",
        [{ route: "tailscale", kind: "tailscale_down" }],
        {
          lan: null,
        }
      )
    );
    expect(v.title).toBe("Tailscale is off on this Mac");
    expect(v.summary).toBe(
      "Studio connects over Tailscale (studio-ts). Turn on Tailscale on this Mac to reconnect."
    );
    expect(v.shortReason).toBe("Tailscale is off on this Mac.");
  });

  it("explains both routes when LAN missed and Tailscale is off", () => {
    const v = view(
      failing("tailscale_down", [
        { route: "lan", kind: "name_not_resolved" },
        { route: "tailscale", kind: "tailscale_down" },
      ])
    );
    expect(v.summary).toBe(
      "Studio isn’t reachable on this network, and Tailscale is off on this Mac. Turn on Tailscale to reconnect."
    );
    expect(v.routeLines).toEqual([
      "LAN (studio.local): name not found on this network",
      "Tailscale (studio-ts): Tailscale is off on this Mac",
    ]);
  });

  it("tells a silent Tailscale peer apart from a generic timeout", () => {
    const v = view(
      failing("timeout", [
        { route: "lan", kind: "name_not_resolved" },
        { route: "tailscale", kind: "timeout" },
      ])
    );
    expect(v.kind).toBe("timeout");
    expect(v.title).toBe("Studio isn’t responding");
    expect(v.summary).toBe(
      "Tailscale is on, but Studio didn’t answer at studio-ts. It may be asleep, shut down or signed out of Tailscale."
    );
    expect(v.shortReason).toBe("Not responding on Tailscale.");
  });

  it("keeps the generic timeout copy for a LAN-only timeout", () => {
    const v = view(
      failing("timeout", [{ route: "lan", kind: "timeout" }], {
        tailscale: null,
      })
    );
    expect(v.title).toBe("Can’t connect to Studio");
    expect(v.shortReason).toBe("LAN (studio.local) timed out.");
  });

  it("points a LAN name miss at the Tailscale setting", () => {
    const v = view(
      failing(
        "name_not_resolved",
        [{ route: "lan", kind: "name_not_resolved" }],
        {
          tailscale: null,
        }
      )
    );
    expect(v.title).toBe("Can’t find Studio");
    expect(v.summary).toBe(
      "studio.local didn’t resolve on this network. If you’re away from Studio’s network, add a Tailscale address in host settings."
    );
    expect(v.shortReason).toBe("studio.local wasn’t found.");
    expect(v.gifTheme).toBe("not-found");
  });

  it("points a Tailscale name miss at the host's settings", () => {
    const v = view(
      failing(
        "name_not_resolved",
        [{ route: "tailscale", kind: "name_not_resolved" }],
        { lan: null }
      )
    );
    expect(v.summary).toBe(
      "Tailscale couldn’t find studio-ts. Check the name in host settings."
    );
  });

  it("names the macOS and Linux fix for a refused SSH connection", () => {
    const mac = view(
      failing("refused", [{ route: "lan", kind: "refused" }], {
        tailscale: null,
      })
    );
    expect(mac.title).toBe("Studio refused SSH");
    expect(mac.summary).toBe(
      "Studio answered but isn’t accepting SSH. Turn on Remote Login in System Settings › General › Sharing on Studio."
    );
    expect(mac.shortReason).toBe("SSH connection refused.");
    const linux = view(
      failing(
        "refused",
        [{ route: "lan", kind: "refused" }],
        { tailscale: null },
        "linux"
      )
    );
    expect(linux.summary).toBe(
      "Studio answered but isn’t accepting SSH. Start sshd on Studio."
    );
  });

  it("reports no route with the network hint", () => {
    const v = view(
      failing("no_route", [{ route: "lan", kind: "no_route" }], {
        tailscale: null,
      })
    );
    expect(v.title).toBe("Can’t reach Studio");
    expect(v.summary).toBe(
      "This Mac has no route to LAN (studio.local). Check that both machines are on the same network and Studio is awake."
    );
    expect(v.shortReason).toBe("No route to Studio.");
  });

  it("lists each route failure in Technical details", () => {
    const v = view(
      failing("timeout", [
        { route: "lan", kind: "refused" },
        { route: "tailscale", kind: "timeout" },
      ])
    );
    expect(v.routeLines).toEqual([
      "LAN (studio.local): SSH refused the connection",
      "Tailscale (studio-ts): didn’t answer in time",
    ]);
    expect(v.diagnostics).toContain("Route LAN: refused");
    expect(v.diagnostics).toContain("Route Tailscale: timeout");
  });

  it("has no route lines while connected", () => {
    const remote = failing("timeout", []);
    remote.status.state = "connected";
    remote.status.failure_kind = null;
    expect(view(remote).routeLines).toEqual([]);
  });
});

it.each([
  [
    "app_not_running",
    "StatGlass isn’t running on Studio Mac",
    "Open StatGlass",
  ],
  [
    "monitoring_off",
    "Remote monitoring is off on Studio Mac",
    "Turn on Allow remote monitoring",
  ],
] as const)(
  "shows the %s marker and retry advice for a saved Mac",
  (kind, title, recovery) => {
    const connection = view(
      failing(kind, [{ route: "lan", kind }], {
        name: "Studio Mac",
        tailscale: null,
      })
    );
    expect(connection.title).toBe(title);
    expect(connection.summary).toContain(recovery);
    expect(connection.kind).toBe(kind);
    expect(connection.showRetry).toBe(true);
    expect(connection.routeLines).not.toContainEqual(
      expect.stringContaining("connection failed")
    );
  }
);
