import {
  createMockTransport,
  MOCK_LOCAL_IPV4,
  MOCK_PUBLIC_IP,
} from "@core/mock-transport";
import { act, render, screen } from "@testing-library/react";
import { createTestQueryClient, renderWithProviders } from "@tests/test-utils";
import { App } from "~/app";
import { HostStoreProvider } from "~/stores/host-store";
import { AddressLine } from "./address-line";

const transport = () => createMockTransport({ autoTick: false });
const addressCalls = (t: ReturnType<typeof transport>) =>
  t.calls.filter((c) => c.command === "get_host_addresses").length;

describe("AddressLine (D-093)", () => {
  it("shows the local and public addresses, each copyable", async () => {
    renderWithProviders(<AddressLine primary="en0" />, {
      transport: transport(),
    });
    expect(
      await screen.findByRole("button", {
        name: `Copy local IP address ${MOCK_LOCAL_IPV4}`,
      })
    ).toBeVisible();
    expect(
      await screen.findByRole("button", {
        name: `Copy public IP address ${MOCK_PUBLIC_IP}`,
      })
    ).toBeVisible();
  });

  it("uses the resolver's tunnel interface and link with no sampled primary", async () => {
    const t = createMockTransport({ autoTick: false, scenarios: ["vpn"] });
    t.getHostAddresses = async () => ({
      status: "ok",
      data: {
        interface: "utun3",
        link_mbps: 2500,
        ipv4: ["192.0.2.24"],
        ipv6: [],
        public_ip: { state: "known", detail: { ip: "203.0.113.24" } },
        as_of_ms: Date.now(),
      },
    });
    render(
      <App transport={t} router={{ initialEntry: "/dashboard/network" }} />
    );
    expect(
      await screen.findByRole("button", {
        name: "Copy local IP address 192.0.2.24",
      })
    ).toBeVisible();
    expect(screen.getByText(/utun3 · 2.5 Gb\/s link/)).toBeVisible();
    expect(screen.queryByText("No active interface")).toBeNull();
  });

  it("shows the selected remote host's addresses on the Network page", async () => {
    const t = createMockTransport({
      scenarios: ["multi-host"],
      autoTick: false,
    });
    render(
      <App
        transport={t}
        initialHost="remote-studio"
        router={{ initialEntry: "/dashboard/network" }}
      />
    );
    expect(
      await screen.findByRole("button", {
        name: "Copy local IP address 192.0.2.20",
      })
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Copy public IP address 203.0.113.20",
      })
    ).toBeVisible();
  });

  it("reads addresses on return after the old Linux host is upgraded", async () => {
    const t = createMockTransport({
      scenarios: ["hosts-outdated"],
      autoTick: false,
    });
    const queryClient = createTestQueryClient();
    const host = (
      <HostStoreProvider hostId="remote-nas">
        <AddressLine primary="end0" />
      </HostStoreProvider>
    );
    await expect(t.getHostAddresses("remote-nas")).resolves.toMatchObject({
      status: "error",
      error: { kind: "remote_unsupported" },
    });
    vi.useFakeTimers();
    try {
      const first = renderWithProviders(host, { transport: t, queryClient });
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(
        screen.queryByRole("button", { name: /Copy.*IP address/ })
      ).toBeNull();
      first.unmount();
      await t.updateRemoteAgent("remote-nas");
      renderWithProviders(host, { transport: t, queryClient });
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(
        screen.getByRole("button", {
          name: "Copy public IP address 203.0.113.20",
        })
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["/dashboard/network", "/dashboard/overview", "/popover"])(
    "shows a command failure without addresses on %s",
    async (initialEntry) => {
      const t = transport();
      t.failNext("getHostAddresses", {
        kind: "remote_busy",
        message: "Try again shortly",
      });
      render(<App transport={t} router={{ initialEntry }} />);
      expect(await screen.findByText("Addresses unavailable")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /Copy.*IP address/ })
      ).toBeNull();
    }
  );

  it("refreshes the public address when the host reports a new route", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = transport();
      const getAddresses = t.getHostAddresses;
      let publicIp = MOCK_PUBLIC_IP;
      t.getHostAddresses = async (host) => {
        const result = await getAddresses(host);
        if (result.status === "error") return result;
        return {
          status: "ok",
          data: {
            ...result.data,
            public_ip: { state: "known", detail: { ip: publicIp } },
          },
        };
      };
      renderWithProviders(<AddressLine primary="en0" />, { transport: t });
      expect(
        await screen.findByRole("button", {
          name: `Copy public IP address ${MOCK_PUBLIC_IP}`,
        })
      ).toBeVisible();

      // Same interface, same LAN address; only the route moves.
      publicIp = "198.51.100.9";
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(
        await screen.findByRole("button", {
          name: "Copy public IP address 198.51.100.9",
        })
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads unavailable when the lookup fails, and does not retry", async () => {
    const t = transport();
    const getAddresses = t.getHostAddresses;
    t.getHostAddresses = async (host) => {
      const result = await getAddresses(host);
      if (result.status === "error") return result;
      return {
        status: "ok",
        data: {
          ...result.data,
          public_ip: { state: "unavailable", detail: { reason: "offline" } },
        },
      };
    };
    renderWithProviders(<AddressLine primary="en0" />, { transport: t });
    expect(await screen.findByText("unavailable")).toBeVisible();
    expect(addressCalls(t)).toBe(1);
  });
});
