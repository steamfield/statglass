import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { HostSelectionContext } from "~/lib/host-selection";
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
  "Battery charge",
];

it("all metric cards follow the shared setting from 5m to 1h", async () => {
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
  for (const name of [
    "CPU",
    "GPU",
    "Memory",
    "Power & Sensors",
    "Network",
    "Disk",
    "Battery",
  ]) {
    const card = await screen.findByRole("link", { name });
    expect(within(card).getByText(/^(?:on battery )?now$/)).toBeVisible();
    expect(
      within(card).getByRole("img", { name: /selected dates/ })
    ).toBeVisible();
  }
  expect(screen.getAllByText("on battery now")).toHaveLength(2);
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

it("renders a Battery card linked to its page", async () => {
  const { user, router } = renderWithProviders(<OverviewRoute />);
  const card = await screen.findByRole("link", {
    name: "Battery",
  });
  expect(within(card).getByText("Health")).toBeVisible();
  expect(within(card).getByText("Battery power")).toBeVisible();
  expect(within(card).queryByRole("list")).toBeNull();
  await user.click(card);
  expect(router.state.location.pathname).toBe("/dashboard/battery");
});

it.each(["no-battery", "linux"] as const)(
  "omits the Battery card on %s",
  async (scenario) => {
    renderWithProviders(<OverviewRoute />, {
      transportOptions: { scenarios: [scenario] },
    });
    await screen.findByRole("img", { name: /^CPU total and system/ });
    expect(screen.queryByRole("link", { name: "Battery" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Battery" })).toBeNull();
  }
);

describe("Overview cards menu (D-132)", () => {
  const menu = async (user: { click: (e: Element) => Promise<void> }) => {
    await user.click(
      await screen.findByRole("button", { name: "Overview cards" })
    );
    return screen.findByRole("menu");
  };

  it("lists only the cards this host can fill", async () => {
    const { user } = renderWithProviders(<OverviewRoute />);
    const items = within(await menu(user))
      .getAllByRole("menuitemcheckbox")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "CPU",
      "GPU",
      "Memory",
      "Power & Sensors",
      "Network",
      "Disk",
      "Battery",
      "Events",
      "Apps",
      "Largest folders",
    ]);
  });

  const cardNames = async (user: { click: (e: Element) => Promise<void> }) =>
    within(await menu(user))
      .getAllByRole("menuitemcheckbox")
      .map((item) => item.textContent);

  it("adds Containers with Docker monitoring on and Other hosts once a host is saved", async () => {
    const { user } = renderWithProviders(<OverviewRoute />, {
      transportOptions: { scenarios: ["docker-11", "multi-host"] },
    });
    await screen.findByRole("heading", { name: "Containers" });
    await screen.findByRole("heading", { name: "Other hosts" });
    expect((await cardNames(user)).slice(-3)).toEqual([
      "Largest folders",
      "Containers",
      "Other hosts",
    ]);
  });

  it("leaves This Mac's cards out while a remote host is on screen", async () => {
    const transport = createMockTransport({
      autoTick: false,
      scenarios: ["docker-11", "multi-host"],
    });
    const hosts = (await transport.listHosts()).map((host) => ({
      ...host,
      is_local: false,
    }));
    const { user } = renderWithProviders(
      <HostSelectionContext
        value={{ hosts, selected: MOCK_HOST_ID, select: () => {} }}
      >
        <OverviewRoute />
      </HostSelectionContext>,
      { transport }
    );
    const names = await cardNames(user);
    expect(names).not.toContain("Largest folders");
    expect(names).not.toContain("Containers");
    expect(names).toContain("Other hosts");
  });

  it("hides a card, saves it, and brings every card back", async () => {
    const { user, transport } = renderWithProviders(<OverviewRoute />);
    await screen.findByRole("link", { name: "Battery" });
    await user.click(
      within(await menu(user)).getByRole("menuitemcheckbox", {
        name: "Battery",
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Battery" })).toBeNull()
    );
    expect((await transport.getSettings()).settings.overview?.battery).toBe(
      false
    );
    // The menu stays open for the next change.
    await user.click(screen.getByRole("menuitem", { name: "Show all" }));
    expect(await screen.findByRole("link", { name: "Battery" })).toBeVisible();
    expect((await transport.getSettings()).settings.overview?.battery).toBe(
      true
    );
  });
});
