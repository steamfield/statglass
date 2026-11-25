import {
  createMockTransport,
  MOCK_LOCAL_IPV4,
  MOCK_PUBLIC_IP,
} from "@core/mock-transport";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
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

  it("does not request addresses without a network", async () => {
    const t = transport();
    const { container } = renderWithProviders(<AddressLine primary={null} />, {
      transport: t,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(addressCalls(t)).toBe(0);
  });

  it("shows no address line when the host cannot answer", async () => {
    const t = transport();
    let answered = false;
    t.getHostAddresses = async () => {
      answered = true;
      return {
        status: "error",
        error: { kind: "remote_unsupported", message: "addresses unavailable" },
      };
    };
    const { container } = renderWithProviders(<AddressLine primary="en0" />, {
      transport: t,
    });
    await waitFor(() => expect(answered).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });

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
      await vi.advanceTimersByTimeAsync(10_000);
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
