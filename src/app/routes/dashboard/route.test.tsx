import { createMockTransport } from "@core/mock-transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { renderWithProviders } from "../../../../tests/test-utils";
import { useAgentUpdating } from "./hosts/_hooks/use-agent-update";
import DashboardLayout from "./route";

function renderShell(
  scenarios: Parameters<typeof renderWithProviders>[1] = {}
) {
  return renderWithProviders(<DashboardLayout />, {
    route: "/dashboard/overview",
    ...scenarios,
  });
}

const sidebarLinks = () =>
  within(screen.getByRole("navigation"))
    .getAllByRole("link")
    .map((a) => a.textContent ?? "");

describe("Dashboard shell", () => {
  it("follows navigate-requested to a dashboard route", async () => {
    const { transport, router } = renderShell();
    act(() => transport.requestNavigate("/dashboard/settings"));
    expect(router.state.location.pathname).toBe("/dashboard/settings");
  });

  it("ignores navigate-requested for a route outside the dashboard", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, router } = renderShell();
    act(() => transport.requestNavigate("/popover"));
    expect(router.state.location.pathname).toBe("/dashboard/overview");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lists every module on a supported MacBook", async () => {
    renderShell();
    await waitFor(() =>
      expect(sidebarLinks().join("|")).toMatch(/Power & Sensors.*Battery/)
    );
  });

  it("leaves Battery out on a Mac without one", async () => {
    renderShell({ transportOptions: { scenarios: ["no-battery"] } });
    // Every module reads "on" until capabilities arrive, then Battery goes.
    await waitFor(() =>
      expect(sidebarLinks().some((t) => t.startsWith("Battery"))).toBe(false)
    );
    expect(sidebarLinks().some((t) => t.startsWith("Disk"))).toBe(true);
  });

  it("leaves Power & Sensors out on an unknown chip", async () => {
    renderShell({ transportOptions: { scenarios: ["unknown-chip"] } });
    await waitFor(() =>
      expect(sidebarLinks().some((t) => t.startsWith("Power"))).toBe(false)
    );
    expect(sidebarLinks().some((t) => t.startsWith("Battery"))).toBe(true);
  });
});

it("keeps the dashboard shell stable when polls change only card facts", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["multi-host", "paused"],
    historyRows: 60,
  });
  const list = transport.listRemoteHosts;
  let polls = 0;
  let connectionChanged = false;
  transport.listRemoteHosts = async () =>
    (await list()).map((host) => ({
      ...host,
      status: {
        ...host.status,
        last_seen_ms: ++polls,
        cpu_pct: polls,
        vitals: { ...host.status.vitals, load_1m: polls },
        update: {
          target: "1.0.0",
          phase: { kind: "uploading", sent_bytes: polls, total_bytes: 100 },
        },
        state: connectionChanged ? "offline" : host.status.state,
      },
    }));
  let renders = 0;
  let mounted: ReturnType<typeof renderWithProviders> | undefined;
  try {
    await act(async () => {
      mounted = renderWithProviders(
        <Profiler id="dashboard" onRender={() => renders++}>
          <DashboardLayout />
        </Profiler>,
        {
          transport,
          route: "/dashboard/hosts",
        }
      );
    });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(polls).toBeGreaterThan(0);
    const before = renders;
    const beforePolls = polls;
    await act(() => vi.advanceTimersByTimeAsync(5001));
    expect(polls).toBeGreaterThan(beforePolls);
    expect(renders).toBe(before);
    connectionChanged = true;
    await act(() => vi.advanceTimersByTimeAsync(5001));
    expect(renders).toBeGreaterThan(before);
  } finally {
    mounted?.unmount();
    transport.dispose();
    vi.useRealTimers();
  }
});

it("refreshes host status on a mock push and derives updating from Rust status", async () => {
  const transport = createMockTransport({
    scenarios: ["multi-host"],
    windowLabel: "popover",
    historyRows: 60,
  });
  function Status() {
    const hosts = useRemoteHosts().data;
    const updating = useAgentUpdating("remote-studio");
    return (
      <p>
        {hosts?.[0]?.status.vitals.load_1m ?? "loading"} ·{" "}
        {updating ? "Updating" : "Idle"}
      </p>
    );
  }
  const mounted = renderWithProviders(<Status />, { transport });
  try {
    await screen.findByText("2.4 · Idle");
    act(() =>
      transport.pushRemoteStatus("remote-studio", {
        update: { target: "1.0.0", phase: { kind: "reconnecting" } },
      })
    );
    await screen.findByText("2.4 · Updating");
    act(() => transport.pushRemoteStatus("remote-studio", { update: null }));
    await screen.findByText("2.4 · Idle");
  } finally {
    mounted.unmount();
    transport.dispose();
  }
});
