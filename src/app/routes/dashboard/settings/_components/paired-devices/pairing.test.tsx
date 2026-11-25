import { createMockTransport } from "@core/mock-transport";
import { unwrap } from "@core/transport";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderWithProviders } from "../../../../../../../tests/test-utils";
import { PairedDevicesPanel } from "./panel";

it("cancels an offer that finishes after the sheet has closed", async () => {
  const mock = createMockTransport({ autoTick: false });
  await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
  let finish = () => {};
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let nonce: string | undefined;
  const { user } = renderWithProviders(<PairedDevicesPanel />, {
    transport: {
      ...mock,
      pairingStart: async () => {
        const result = await mock.pairingStart();
        if (result.status === "ok") nonce = result.data.nonce;
        await blocked;
        return result;
      },
    },
  });
  await user.click(screen.getByRole("button", { name: "Pair iPhone" }));
  await screen.findByText("Preparing pairing code…");
  await waitFor(() => expect(nonce).toBeDefined());
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => finish());
  await waitFor(async () => {
    expect(await unwrap(mock.pairingStatus(nonce ?? ""))).toEqual({
      kind: "denied",
    });
  });
});

it("shows a failed device read and retries through the transport", async () => {
  const mock = createMockTransport({ autoTick: false });
  let unavailable = true;
  const { user } = renderWithProviders(<PairedDevicesPanel />, {
    transport: {
      ...mock,
      pairedDevices: async () => {
        if (unavailable) throw new Error("Couldn’t read authorized keys.");
        return mock.pairedDevices();
      },
    },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t read authorized keys."
  );
  expect(screen.queryByText("No paired devices.")).not.toBeInTheDocument();

  unavailable = false;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Home iPhone")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("cancels a pairing offer when the dashboard is hidden", async () => {
  const mock = createMockTransport({ autoTick: false });
  await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
  mock.setWindowVisible(false);
  let nonce: string | undefined;
  const { user } = renderWithProviders(<PairedDevicesPanel />, {
    transport: {
      ...mock,
      pairingStart: async () => {
        const result = await mock.pairingStart();
        if (result.status === "ok") nonce = result.data.nonce;
        return result;
      },
    },
  });
  await user.click(screen.getByRole("button", { name: "Pair iPhone" }));
  await screen.findByRole("img", { name: "Pairing QR code" });
  act(() => mock.setWindowVisible(true));
  expect(screen.getByRole("dialog")).toBeVisible();
  act(() => mock.setWindowVisible(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  );
  expect(await unwrap(mock.pairingStatus(nonce ?? ""))).toEqual({
    kind: "denied",
  });
});

it("identifies same-name phones in revoke controls and explains an active connection", async () => {
  const mock = createMockTransport({ autoTick: false });
  const [device] = await unwrap(mock.pairedDevices());
  if (!device) throw new Error("Missing paired device fixture");
  const { user } = renderWithProviders(<PairedDevicesPanel />, {
    transport: {
      ...mock,
      pairedDevices: async () => ({
        status: "ok",
        data: [device, { ...device, tag: "A2B3C4" }],
      }),
    },
  });
  await user.click(
    await screen.findByRole("button", { name: "Revoke Home iPhone (A2B3C4)" })
  );
  const confirmation = screen.getByRole("alertdialog", {
    name: "Revoke Home iPhone (A2B3C4)?",
  });
  expect(
    within(confirmation).getByText(
      /A phone that's already connected stays connected until it disconnects/
    )
  ).toBeInTheDocument();
});

it("announces a pending iPhone without making the countdown a live region", async () => {
  vi.useFakeTimers();
  try {
    const mock = createMockTransport({ autoTick: false });
    await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
    renderWithProviders(<PairedDevicesPanel />, { transport: mock });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Pair iPhone" }))
    );
    await act(() => vi.advanceTimersByTimeAsync(4000));
    const dialog = screen.getByRole("dialog");
    const announcement = within(dialog).getByRole("status");
    expect(announcement).toHaveTextContent(
      "Travel iPhone is waiting for approval."
    );
    expect(announcement).not.toHaveTextContent("Expires");
  } finally {
    vi.useRealTimers();
  }
});

it("shows the denial returned by the command without polling again", async () => {
  vi.useFakeTimers();
  const mock = createMockTransport({ autoTick: false });
  try {
    await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
    renderWithProviders(<PairedDevicesPanel />, { transport: mock });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Pair iPhone" }))
    );
    await act(() => vi.advanceTimersByTimeAsync(4000));

    const calls = mock.calls.length;
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    );
    await act(() => vi.advanceTimersByTimeAsync(1100));
    expect(screen.getByText("Pairing denied.")).toBeVisible();
    expect(mock.calls.slice(calls).map(({ command }) => command)).toEqual([
      "pairing_deny",
    ]);
  } finally {
    mock.dispose();
    vi.useRealTimers();
  }
});

it("shows monitoring guidance when an open pairing is withdrawn", async () => {
  vi.useFakeTimers();
  try {
    const mock = createMockTransport({ autoTick: false });
    await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
    renderWithProviders(<PairedDevicesPanel />, { transport: mock });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Pair iPhone" }))
    );
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();

    await act(() =>
      unwrap(mock.updateSettings({ remote_access: { enabled: false } }))
    );
    await act(() => vi.advanceTimersByTimeAsync(1100));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Remote monitoring is off on this host."
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Turn on Allow remote monitoring in StatGlass Settings, then try pairing again."
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("shows the monitoring-off reason and recovery before opening an offer", async () => {
  const mock = createMockTransport({ autoTick: false });
  const { user } = renderWithProviders(<PairedDevicesPanel />, {
    transport: mock,
  });
  await user.click(screen.getByRole("button", { name: "Pair iPhone" }));
  const alert = await within(screen.getByRole("dialog")).findByRole("alert");
  expect(alert).toHaveTextContent("Remote monitoring is off on this host.");
  expect(alert).toHaveTextContent("Turn on Allow remote monitoring");
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
});

it("shows the typed reason with detail when polling or approval fails", async () => {
  vi.useFakeTimers();
  try {
    const mock = createMockTransport({ autoTick: false });
    await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
    let failStatus = false;
    renderWithProviders(<PairedDevicesPanel />, {
      transport: {
        ...mock,
        pairingStatus: async (nonce) =>
          failStatus
            ? {
                status: "error",
                error: {
                  kind: "pairing",
                  reason: "unknown",
                  message: "The offer was withdrawn.",
                },
              }
            : mock.pairingStatus(nonce),
        pairingApprove: async () => ({
          status: "error",
          error: {
            kind: "pairing",
            reason: "used",
            message: "A decision was already recorded.",
          },
        }),
      },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Pair iPhone" }))
    );
    await act(() => vi.advanceTimersByTimeAsync(4000));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    );
    await act(() => vi.advanceTimersByTimeAsync(1));
    let alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The pairing code has already been used.");
    expect(alert).toHaveTextContent("A decision was already recorded.");

    failStatus = true;
    await act(() => vi.advanceTimersByTimeAsync(1100));
    alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "The host does not recognize this pairing code."
    );
    expect(alert).toHaveTextContent("The offer was withdrawn.");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("expires a pending offer and removes the approval controls", async () => {
  vi.useFakeTimers();
  try {
    const mock = createMockTransport({ autoTick: false });
    await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
    renderWithProviders(<PairedDevicesPanel />, { transport: mock });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Pair iPhone" }))
    );
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();

    vi.setSystemTime(Date.now() + 600_000);
    await act(() => vi.advanceTimersByTimeAsync(1100));
    expect(screen.getByText(/Pairing expired\./)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("returns monitoring guidance when approval races with disabling monitoring", async () => {
  const mock = createMockTransport({ autoTick: false });
  await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
  const { nonce } = await unwrap(mock.pairingStart());
  await unwrap(mock.updateSettings({ remote_access: { enabled: false } }));
  const status = await unwrap(mock.pairingApprove(nonce));
  expect(status).toEqual({
    kind: "failed",
    reason: "monitoring_off",
    message:
      "Turn on Allow remote monitoring in StatGlass Settings, then try pairing again.",
  });
  await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
  expect(await unwrap(mock.pairingStatus(nonce))).toEqual(status);
});

it("refreshes paired devices when polling recovers a committed approval", async () => {
  vi.useFakeTimers();
  try {
    const mock = createMockTransport({ autoTick: false });
    await unwrap(mock.updateSettings({ remote_access: { enabled: true } }));
    renderWithProviders(<PairedDevicesPanel />, {
      transport: {
        ...mock,
        pairingApprove: async (nonce) => {
          await unwrap(mock.pairingApprove(nonce));
          throw new Error("The approval reply was interrupted.");
        },
      },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Pair iPhone" }))
    );
    const tick = async (ms: number) => {
      await act(() => vi.advanceTimersByTimeAsync(ms));
    };
    await tick(4000);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    );
    await tick(1001);
    await tick(10);
    expect(screen.getByText("iPhone paired.")).toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Close" }))
    );
    const panel = screen.getByRole("region", { name: "Paired devices" });
    expect(within(panel).getByText("Travel iPhone")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
