import { createMockTransport, MOCK_PUBLIC_IP } from "@core/mock-transport";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { AddressLine } from "~/routes/dashboard/network/_components/address-line";
import { HostStoreProvider } from "~/stores/host-store";

const addressReads = (transport: ReturnType<typeof createMockTransport>) =>
  transport.calls.filter(({ command }) => command === "get_host_addresses")
    .length;

function pendingHost() {
  const transport = createMockTransport({ autoTick: false });
  const read = transport.getHostAddresses;
  let pending = true;
  transport.getHostAddresses = async (host) => {
    const result = await read(host);
    if (result.status === "error" || !pending) return result;
    return {
      status: "ok",
      data: { ...result.data, public_ip: { state: "pending" } },
    };
  };
  renderWithProviders(<AddressLine primary="en0" />, { transport });
  return {
    transport,
    resolve() {
      pending = false;
    },
  };
}

async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

function GatedAddressLine() {
  const [show, setShow] = useState(false);
  return show ? (
    <AddressLine primary="en0" />
  ) : (
    <button type="button" onClick={() => setShow(true)}>
      Show addresses
    </button>
  );
}

describe("address polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a pending public IP and replaces it at the first 2 s poll", async () => {
    const { transport, resolve } = pendingHost();
    await advance(1);
    expect(screen.getByText("…")).toBeVisible();
    resolve();

    await advance(1998);
    expect(addressReads(transport)).toBe(1);
    await advance(3);
    expect(
      screen.getByRole("button", {
        name: `Copy public IP address ${MOCK_PUBLIC_IP}`,
      })
    ).toBeVisible();
    expect(addressReads(transport)).toBe(2);
  });

  it("returns to the 10 s cadence after five pending polls", async () => {
    const { transport, resolve } = pendingHost();
    await advance(10_001);
    expect(addressReads(transport)).toBe(6);
    resolve();

    await advance(2_000);
    expect(screen.getByText("…")).toBeVisible();
    expect(addressReads(transport)).toBe(6);
    await advance(8_000);
    expect(
      screen.getByRole("button", { name: /Copy public IP address/ })
    ).toBeVisible();
    expect(addressReads(transport)).toBe(7);
  });

  it("pauses pending polls while hidden and reads again when shown", async () => {
    const { transport, resolve } = pendingHost();
    await advance(1);
    expect(screen.getByText("…")).toBeVisible();
    act(() => transport.setWindowVisible(false));
    await advance(12_000);
    expect(addressReads(transport)).toBe(1);
    resolve();

    act(() => transport.setWindowVisible(true));
    await advance(1);
    expect(
      screen.getByRole("button", { name: /Copy public IP address/ })
    ).toBeVisible();
    expect(addressReads(transport)).toBe(2);
  });

  it("waits for a hidden window to open before the first read", async () => {
    const transport = createMockTransport({ autoTick: false });
    transport.setWindowVisible(false);
    renderWithProviders(<GatedAddressLine />, { transport });
    await advance(1);
    fireEvent.click(screen.getByRole("button", { name: "Show addresses" }));
    await advance(1);
    expect(addressReads(transport)).toBe(0);

    act(() => transport.setWindowVisible(true));
    await advance(1);
    expect(
      screen.getByRole("button", { name: /Copy public IP address/ })
    ).toBeVisible();
    expect(addressReads(transport)).toBe(1);
  });

  it("does not retry or poll a host without the address feature", async () => {
    const transport = createMockTransport({
      autoTick: false,
      scenarios: ["hosts-outdated"],
    });
    renderWithProviders(
      <HostStoreProvider hostId="remote-nas">
        <AddressLine primary="end0" />
      </HostStoreProvider>,
      { transport }
    );
    await advance(30_000);
    act(() => transport.setWindowVisible(false));
    act(() => transport.setWindowVisible(true));
    await advance(10_000);
    expect(addressReads(transport)).toBe(1);
    expect(screen.getByText("end0", { exact: true })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Copy.*IP address/ })
    ).toBeNull();
    expect(screen.queryByText("Addresses unavailable")).toBeNull();
  });
});
