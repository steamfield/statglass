import { createMockTransport } from "@core/mock-transport";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../../../../../../tests/test-utils";
import { DeviceIntents } from ".";

it("shows a pending install and a failed revoke until retry settles them", async () => {
  const transport = createMockTransport({ autoTick: false });
  const { user } = renderWithProviders(<DeviceIntents />, { transport });

  expect(
    await screen.findByText("Install pending · iPhone 7F3A2C")
  ).toBeVisible();
  expect(screen.getByText("Revoke failed · iPhone A1B2C3")).toBeVisible();
  expect(screen.getByText("Host is offline.")).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Retry device updates" })
  );

  await waitFor(() => {
    expect(
      screen.queryByText("Install pending · iPhone 7F3A2C")
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("Revoke failed · iPhone A1B2C3")).toBeVisible();
});

it("shows a failed read and can retry to an empty list", async () => {
  const mock = createMockTransport({ autoTick: false });
  let fail = true;
  const { user } = renderWithProviders(<DeviceIntents />, {
    transport: {
      ...mock,
      deviceIntents: async () => {
        if (fail) {
          fail = false;
          return {
            status: "error",
            error: { kind: "handover", message: "Intent log is unreadable." },
          };
        }
        return { status: "ok", data: [] };
      },
    },
  });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Intent log is unreadable."
  );
  await user.click(
    screen.getByRole("button", { name: "Retry device updates" })
  );
  expect(await screen.findByText("No pending device updates.")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Retry device updates" })
  ).not.toBeInTheDocument();
});

it("shows a retry failure and keeps the saved intent visible", async () => {
  const mock = createMockTransport({ autoTick: false });
  const { user } = renderWithProviders(<DeviceIntents />, {
    transport: {
      ...mock,
      retryDeviceIntents: async () => ({
        status: "error",
        error: {
          kind: "handover",
          message: "The device intent worker has stopped.",
        },
      }),
    },
  });

  await user.click(
    await screen.findByRole("button", { name: "Retry device updates" })
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The device intent worker has stopped."
  );
  expect(screen.getByText("Install pending · iPhone 7F3A2C")).toBeVisible();
});

it("clears a stale retry error when the pending list drains", async () => {
  vi.useFakeTimers();
  const mock = createMockTransport({ autoTick: false });
  let settled = false;
  try {
    renderWithProviders(<DeviceIntents />, {
      transport: {
        ...mock,
        deviceIntents: async () =>
          settled ? { status: "ok", data: [] } : mock.deviceIntents(),
        retryDeviceIntents: async () => ({
          status: "error",
          error: {
            kind: "handover",
            message: "The device intent worker has stopped.",
          },
        }),
      },
    });
    await act(() => vi.advanceTimersByTimeAsync(10));
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Retry device updates" })
      )
    );
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByRole("alert")).toBeVisible();
    settled = true;
    await act(() => vi.advanceTimersByTimeAsync(10010));
    expect(screen.getByText("No pending device updates.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    settled = false;
    await act(() => vi.advanceTimersByTimeAsync(10010));
    expect(screen.getByText("Install pending · iPhone 7F3A2C")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    mock.dispose();
    vi.useRealTimers();
  }
});
