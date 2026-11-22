import type { RemoteHostRecord } from "@core/generated/bindings";
import { mockHostVitals } from "@core/mock/remote-updates";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { HostSelectionContext } from "~/lib/host-selection";
import { remoteHostCardModel } from "../_lib/host-card-model";
import HostsRoute from "../route";
import { HostCardReconnect } from "./host-card-reconnect";

const NOW = 1_795_000_000_000;

function studio(status: Partial<RemoteHostRecord["status"]>): RemoteHostRecord {
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
      attempt: 1,
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

function showPanel(remote: RemoteHostRecord) {
  const model = remoteHostCardModel(remote);
  if (!model.reconnect) throw new Error("expected a reconnect panel");
  return render(
    <HostCardReconnect panel={model.reconnect} retry={model.retry} />
  );
}

describe("host card reconnect panel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("counts down to the next attempt and explains the slowing retries", () => {
    showPanel(studio({ next_attempt_ms: NOW + 12_000, attempt: 3 }));
    expect(screen.getByText("Reconnecting to Studio")).toBeVisible();
    expect(screen.getByText("LAN (studio.local) timed out.")).toBeVisible();
    expect(screen.getByText("Next attempt in 12 s")).toBeVisible();
    expect(
      screen.getByText(
        /^Attempt 3 · retries slow to once a minute · Last reading /
      )
    ).toBeVisible();
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText("Next attempt in 7 s")).toBeVisible();
  });

  it("says which route it is trying and how long it may take", () => {
    showPanel(studio({ dialing: true }));
    expect(
      screen.getByText("Trying LAN (studio.local) now · gives up after 15 s")
    ).toBeVisible();
    expect(screen.queryByText(/Next attempt/)).toBeNull();
  });

  it("leaves out the attempt count before retries slow down", () => {
    showPanel(studio({ next_attempt_ms: NOW + 1_000, attempt: 1 }));
    expect(screen.queryByText(/Attempt/)).toBeNull();
    expect(screen.getByText(/^Last reading /)).toBeVisible();
  });

  it("waits for this Mac's network without a countdown", () => {
    showPanel(
      studio({
        failure_kind: "local_offline",
        route_failures: [{ route: "lan", kind: "local_offline" }],
        waiting_for_network: true,
      })
    );
    expect(screen.getByText("Waiting for network")).toBeVisible();
    expect(
      screen.getByText("Reconnects when this Mac is back online")
    ).toBeVisible();
    expect(screen.queryByText(/Next attempt|Trying/)).toBeNull();
  });

  it("reads Connecting on a first attempt", () => {
    showPanel(
      studio({
        failure_kind: null,
        route_failures: [],
        last_seen_ms: null,
        attempt: 0,
        dialing: true,
      })
    );
    expect(screen.getByText("Connecting to Studio")).toBeVisible();
    expect(screen.queryByText(/Last reading|Attempt/)).toBeNull();
  });

  it("shows no timer while the connection is off", () => {
    showPanel(
      studio({ state: "disabled", failure_kind: null, route_failures: [] })
    );
    expect(screen.getByText("Connection off")).toBeVisible();
    expect(screen.queryByText(/Next attempt|Trying|Reconnects/)).toBeNull();
  });

  it("is absent on a live card", () => {
    const live = studio({
      state: "connected",
      route: "lan",
      failure_kind: null,
      route_failures: [],
    });
    expect(remoteHostCardModel(live).reconnect).toBeNull();
  });
});

describe("hosts page with hosts that aren't live", () => {
  const sources: MockTransport[] = [];
  afterEach(() => {
    cleanup();
    for (const source of sources.splice(0)) source.dispose();
  });

  async function mount(scenarios: Parameters<typeof createMockTransport>[0]) {
    const source = createMockTransport({ autoTick: false, ...scenarios });
    sources.push(source);
    const hosts = await source.listHosts();
    renderWithProviders(
      <HostSelectionContext.Provider
        value={{ hosts, selected: hosts[0]?.id ?? "", select: vi.fn() }}
      >
        <HostsRoute />
      </HostSelectionContext.Provider>,
      { transport: source, route: "/dashboard/hosts" }
    );
    await screen.findByRole("region", { name: "studio" });
  }

  it("replaces a failing card's readings with the panel and keeps them on live cards", async () => {
    await mount({ scenarios: ["hosts-dashboard"] });
    const offline = within(screen.getByRole("region", { name: "offline" }));
    expect(offline.getByText("Reconnecting to offline")).toBeVisible();
    expect(offline.queryByText("Mem pressure")).toBeNull();
    expect(
      offline.getByRole("button", { name: "View metrics" })
    ).toBeInTheDocument();
    const build = within(screen.getByRole("region", { name: "build" }));
    expect(build.getByText("Mem pressure")).toBeInTheDocument();
    expect(build.queryByRole("region", { name: "Connection" })).toBeNull();
  });

  it("shows one offline notice and leaves hosts with connections off alone", async () => {
    await mount({ scenarios: ["hosts-dashboard", "mac-offline"] });
    expect(
      screen.getAllByText(
        "This Mac is offline. Hosts reconnect on their own when the network is back."
      )
    ).toHaveLength(1);
    const build = within(screen.getByRole("region", { name: "build" }));
    expect(build.getAllByText("Waiting for network").length).toBeGreaterThan(0);
    expect(build.getAllByText("This Mac is offline.")).toHaveLength(1);
    const off = within(screen.getByRole("region", { name: "studio" }));
    expect(off.queryByText(/Waiting for network/)).toBeNull();
    expect(off.getAllByText("Connection off").length).toBeGreaterThan(0);
  });
});
