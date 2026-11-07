import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import OverviewRoute from "./route";

const interest = (calls: { command: string; args: unknown[] }[]) =>
  calls
    .filter((c) => c.command === "set_process_interest")
    .map((c) => c.args[1]);

describe("Overview process interest", () => {
  it("asks for process rows while mounted and withdraws on unmount", async () => {
    const { transport, unmount } = renderWithProviders(<OverviewRoute />);
    await screen.findByRole("heading", { name: "Overview" });
    await waitFor(() => expect(interest(transport.calls)).toEqual([true]));
    unmount();
    await waitFor(() =>
      expect(interest(transport.calls)).toEqual([true, false])
    );
  });

  it("asks for network rates only when the host can attribute them (D-081)", async () => {
    const views = (calls: { command: string; args: unknown[] }[]) =>
      calls
        .filter((c) => c.command === "set_process_interest")
        .map((c) => c.args[2] as { sort: string[]; network?: boolean });
    const on = renderWithProviders(<OverviewRoute />);
    await waitFor(() =>
      expect(views(on.transport.calls).at(-1)).toMatchObject({
        sort: ["cpu", "memory", "energy", "disk_total", "net_total", "gpu"],
        network: true,
      })
    );
    on.unmount();

    const off = renderWithProviders(<OverviewRoute />, {
      transportOptions: { scenarios: ["no-process-network"] },
    });
    await waitFor(() => expect(views(off.transport.calls)).toHaveLength(1));
    expect(views(off.transport.calls)[0]?.network).toBeUndefined();
    expect(views(off.transport.calls)[0]?.sort).not.toContain("net_total");
  });

  it("asks for GPU time only when the host can attribute it (D-085)", async () => {
    const views = (calls: { command: string; args: unknown[] }[]) =>
      calls
        .filter((c) => c.command === "set_process_interest")
        .map((c) => c.args[2] as { sort: string[]; gpu?: boolean });
    const on = renderWithProviders(<OverviewRoute />, {
      transportOptions: { scenarios: ["no-process-network"] },
    });
    await waitFor(() =>
      expect(views(on.transport.calls).at(-1)).toMatchObject({
        sort: ["cpu", "memory", "energy", "disk_total", "gpu"],
        gpu: true,
      })
    );
    on.unmount();

    const off = renderWithProviders(<OverviewRoute />, {
      transportOptions: { scenarios: ["no-process-gpu"] },
    });
    await waitFor(() => expect(views(off.transport.calls)).toHaveLength(1));
    expect(views(off.transport.calls)[0]?.gpu).toBeUndefined();
    expect(views(off.transport.calls)[0]?.sort).not.toContain("gpu");
  });

  it("logs a failed set_process_interest with the host and window", async () => {
    const transport = createMockTransport({ autoTick: false });
    transport.setProcessInterest = async () => ({
      status: "error",
      error: { kind: "unknown_host", host: MOCK_HOST_ID },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithProviders(<OverviewRoute />, { transport });
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "[processes] set_process_interest failed",
        expect.objectContaining({ hostId: MOCK_HOST_ID, window: "dashboard" })
      )
    );
    log.mockRestore();
  });
});

const SUBJECTS = [
  "CPU total and system",
  "GPU utilization",
  "Memory pressure",
  "System power",
  "Network",
  "Disk I/O",
];

it("all six cards follow the shared setting from 5m to 1h", async () => {
  const { transport } = renderWithProviders(<OverviewRoute />, {
    transportOptions: { chartWindow: "5m" },
  });
  for (const subject of SUBJECTS)
    expect(
      await screen.findByRole("img", {
        name: new RegExp(`^${subject}.*?, last 5 minutes`),
      })
    ).toBeVisible();
  await act(async () => {
    await transport.updateSettings({ general: { chart_window: "1h" } });
  });
  for (const subject of SUBJECTS)
    expect(
      await screen.findByRole("img", {
        name: new RegExp(`^${subject}.*?, last hour`),
      })
    ).toBeVisible();
  expect(screen.getByRole("radio", { name: "1h" })).toBeChecked();
  expect(screen.getAllByText("Now")).toHaveLength(6);
});

it("fixed dates mark each live headline now, preserving the Power source", async () => {
  const to = Date.now() - 86400000;
  renderWithProviders(<OverviewRoute />, {
    transportOptions: {
      chartWindow: { absolute: { from_ms: to - 3600000, to_ms: to } },
    },
  });
  for (const subject of SUBJECTS) {
    const chart = await screen.findByRole("img", {
      name: new RegExp(`^${subject}.*?, selected dates`),
    });
    const card = chart.closest("a");
    expect(card?.querySelector("header")).toHaveTextContent(/ now$/);
  }
  expect(screen.getByText("on battery now")).toBeVisible();
});

it("Linux charts used memory with the Linux facts", async () => {
  renderWithProviders(<OverviewRoute />, {
    transportOptions: { scenarios: ["linux"], chartWindow: "5m" },
  });
  expect(
    await screen.findByRole("img", {
      name: /^Memory used and cached files, last 5 minutes/,
    })
  ).toBeVisible();
  expect(screen.queryByRole("img", { name: /^Memory pressure/ })).toBeNull();
  expect(screen.getByText("Pressure stall")).toBeVisible();
  expect(screen.getByText("Cached")).toBeVisible();
});

it("shows the machine header while settings are still pending", async () => {
  const transport = createMockTransport({ autoTick: false });
  const settings = await transport.getSettings();
  let release: ((value: typeof settings) => void) | undefined;
  transport.getSettings = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  renderWithProviders(<OverviewRoute />, { transport });
  expect(await screen.findByRole("region", { name: "This Mac" })).toBeVisible();
  expect(
    screen.queryByRole("list", { name: "Top processes by CPU" })
  ).toBeNull();
  await act(async () => {
    release?.(settings);
  });
  expect(
    await screen.findByRole("list", { name: "Top processes by CPU" })
  ).toBeVisible();
});
