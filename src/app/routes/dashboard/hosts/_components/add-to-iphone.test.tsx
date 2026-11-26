import { createMockTransport } from "@core/mock-transport";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { onlineManager } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import { createTestQueryClient, renderWithProviders } from "@tests/test-utils";
import HostsRoute from "../route";

function mockWithRemoteHosts(now = Date.now) {
  return createMockTransport({
    autoTick: false,
    scenarios: ["hosts-dashboard"],
    now,
  });
}

const addButton = { name: "Add to iPhone" };

function pauseLookup() {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, resume: () => release?.() };
}

async function waitForAction() {
  await waitFor(() => {
    const button = screen.getByRole("button", addButton);
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled", "true");
  });
}

it("opens Pair iPhone without devices and Update iPhone after approval", async () => {
  let clockOffset = 0;
  const mock = mockWithRemoteHosts(() => Date.now() + clockOffset);
  const [device] = await unwrap(mock.pairedDevices());
  if (!device) throw new Error("Missing paired device fixture");
  await unwrap(mock.revokeDevice(device.tag));
  await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
  const refresh = pauseLookup();
  let pauseRefresh = false;
  const { user } = renderWithProviders(<HostsRoute />, {
    transport: {
      ...mock,
      pairedDevices: async () => {
        if (pauseRefresh) await refresh.pending;
        return mock.pairedDevices();
      },
    },
  });
  await waitForAction();
  expect(screen.queryByRole("button", { name: "Pair iPhone" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Update iPhone" })).toBeNull();

  await user.click(screen.getByRole("button", addButton));
  expect(
    await screen.findByRole("dialog", { name: "Pair iPhone" })
  ).toBeVisible();
  expect(
    await screen.findByRole("img", { name: "Pairing QR code" })
  ).toBeVisible();
  // Advance the mock phone past its three-second scan delay.
  clockOffset = 3000;
  pauseRefresh = true;
  await user.click(
    await screen.findByRole("button", { name: "Approve" }, { timeout: 3000 })
  );
  expect(await screen.findByText("iPhone paired.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.getByRole("button", addButton)).toHaveFocus()
  );
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  refresh.resume();
  await waitForAction();
  await user.click(screen.getByRole("button", addButton));
  expect(
    await screen.findByRole("dialog", { name: "Update iPhone" })
  ).toBeVisible();
});

it("shows the update QR and included hosts with a paired device", async () => {
  const { user } = renderWithProviders(<HostsRoute />, {
    transport: mockWithRemoteHosts(),
  });
  await waitForAction();
  await user.click(screen.getByRole("button", addButton));
  expect(
    await screen.findByRole("img", { name: "iPhone update QR code" })
  ).toBeVisible();
  const dialog = within(screen.getByRole("dialog", { name: "Update iPhone" }));
  expect(dialog.getByRole("heading", { name: "Included hosts" })).toBeVisible();
  expect(dialog.getByText("build-server")).toBeVisible();
  expect(dialog.getByText("Lab Mini")).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.getByRole("button", addButton)).toHaveFocus()
  );
});

it("disables Add to iPhone while paired devices load", async () => {
  const mock = mockWithRemoteHosts();
  const lookup = pauseLookup();
  renderWithProviders(<HostsRoute />, {
    transport: {
      ...mock,
      pairedDevices: async () => {
        await lookup.pending;
        return mock.pairedDevices();
      },
    },
  });
  expect(await screen.findByRole("button", addButton)).toBeDisabled();
  lookup.resume();
  await waitForAction();
});

const readFailure = {
  kind: "pairing",
  reason: "unknown",
  message: "Couldn’t read devices.",
} as const;

it("rechecks devices on click after a failed lookup and opens Update iPhone", async () => {
  const mock = mockWithRemoteHosts();
  mock.failNext("pairedDevices", readFailure);
  const { user } = renderWithProviders(<HostsRoute />, { transport: mock });
  await waitForAction();
  await user.click(screen.getByRole("button", addButton));
  expect(
    await screen.findByRole("dialog", { name: "Update iPhone" })
  ).toBeVisible();
});

it("opens Pair iPhone and shows its own failure when devices cannot be read", async () => {
  const mock = mockWithRemoteHosts();
  mock.failNext("pairedDevices", readFailure);
  mock.failNext("pairedDevices", readFailure);
  const { user } = renderWithProviders(<HostsRoute />, { transport: mock });
  await waitForAction();
  await user.click(screen.getByRole("button", addButton));
  expect(
    await screen.findByRole("dialog", { name: "Pair iPhone" })
  ).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Remote monitoring is off on this host."
  );
});

it("opens Pair iPhone when the last device is revoked while Hosts stays open", async () => {
  const mock = mockWithRemoteHosts();
  const [device] = await unwrap(mock.pairedDevices());
  if (!device) throw new Error("Missing paired device fixture");
  const { user } = renderWithProviders(<HostsRoute />, { transport: mock });
  await waitForAction();
  await unwrap(mock.revokeDevice(device.tag));
  await user.click(screen.getByRole("button", addButton));
  expect(
    await screen.findByRole("dialog", { name: "Pair iPhone" })
  ).toBeVisible();
});

it("can prepare an update with saved hosts while the webview is offline", async () => {
  const mock = mockWithRemoteHosts();
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(hostKeys.remote(), await mock.listRemoteHosts());
  const wasOnline = onlineManager.isOnline();
  onlineManager.setOnline(false);
  try {
    const { user } = renderWithProviders(<HostsRoute />, {
      transport: mock,
      queryClient,
    });
    await waitForAction();
    await user.click(screen.getByRole("button", addButton));
    expect(
      await screen.findByRole("img", { name: "iPhone update QR code" })
    ).toBeVisible();
  } finally {
    onlineManager.setOnline(wasOnline);
  }
});

it("hides Add to iPhone when no saved host connects automatically", async () => {
  const mock = mockWithRemoteHosts();
  for (const { config } of await mock.listRemoteHosts())
    await mock.updateRemoteHost({ ...config, enabled: false });
  renderWithProviders(<HostsRoute />, { transport: mock });
  expect(await screen.findByText("studio")).toBeVisible();
  expect(screen.queryByRole("button", addButton)).not.toBeInTheDocument();
});

it("hides Add to iPhone when there are no saved remote hosts", async () => {
  renderWithProviders(<HostsRoute />);
  expect(
    await screen.findByText(/Add a Linux server or another Mac/)
  ).toBeVisible();
  expect(screen.queryByRole("button", addButton)).not.toBeInTheDocument();
});
