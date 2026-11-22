import { createMockTransport } from "@core/mock-transport";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import ContainersRoute from "./route";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("opens Docker Desktop from the not-running card and shows the live page once the engine answers", async () => {
  // Fake timers before render so the mock's launch delay runs on them.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const result = renderWithProviders(<ContainersRoute />, {
    transportOptions: { scenarios: ["docker-not-running"] },
  });
  try {
    expect(
      await screen.findByText("Docker Desktop isn’t running")
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Docker Desktop" })
    );
    expect(await screen.findByText("Starting Docker Desktop…")).toBeVisible();
    expect(screen.getByText("Waiting for Docker Desktop…")).toBeVisible();
    expect(screen.queryByRole("table", { name: "Containers now" })).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(
      await screen.findByRole("table", { name: "Containers now" })
    ).toBeVisible();
    expect(screen.queryByText("Starting Docker Desktop…")).toBeNull();
  } finally {
    result.unmount();
    result.transport.dispose();
  }
});

it("counts down to the next automatic attempt", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const result = renderWithProviders(<ContainersRoute />, {
    transportOptions: { scenarios: ["docker-not-running"] },
  });
  try {
    // The mock schedules the next attempt 8 s after the snapshot.
    expect(await screen.findByText(/^Retrying in [78] s$/)).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByText("Retrying in 5 s")).toBeVisible();
  } finally {
    result.unmount();
    result.transport.dispose();
  }
});

it("shows a launch failure under the card and clears it after Retry now", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const transport = createMockTransport({ scenarios: ["docker-not-running"] });
  const message = "Couldn’t open Docker Desktop: LSOpenURLsWithRole() failed";
  transport.dockerLaunchRuntime = async () => ({
    status: "error",
    error: { kind: "docker", message },
  });
  // The engine still isn't answering when the retry lands.
  transport.dockerResume = transport.dockerSnapshot;
  const result = renderWithProviders(<ContainersRoute />, { transport });
  try {
    await result.user.click(
      await screen.findByRole("button", { name: "Open Docker Desktop" })
    );
    expect(await screen.findByText(message)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open Docker Desktop" })
    ).toBeEnabled();

    await result.user.click(screen.getByRole("button", { name: "Retry now" }));
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByText("Docker Desktop isn’t running")).toBeVisible();
  } finally {
    result.unmount();
    transport.dispose();
  }
});

it("copies the start command when Colima is the only engine", async () => {
  const result = renderWithProviders(<ContainersRoute />, {
    transportOptions: { scenarios: ["docker-colima"] },
  });
  // After render: user-event installs its own clipboard during setup.
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  try {
    expect(await screen.findByText("Colima isn’t running")).toBeVisible();
    await result.user.click(
      screen.getByRole("button", { name: "Copy command" })
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
  } finally {
    result.unmount();
    result.transport.dispose();
  }
});

it("switches between the stopped card and saved history", async () => {
  const result = renderWithProviders(<ContainersRoute />, {
    transportOptions: { scenarios: ["docker-stopped"] },
  });
  try {
    await result.user.click(
      await screen.findByRole("button", { name: "View saved history" })
    );
    expect(
      screen.getByText("Docker Desktop stopped · showing saved history")
    ).toBeVisible();
    expect(screen.getByLabelText("Containers view")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Open Docker Desktop" })
    ).toBeNull();

    await result.user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("button", { name: "Open Docker Desktop" })
    ).toBeVisible();
    expect(
      screen.queryByText("Docker Desktop stopped · showing saved history")
    ).toBeNull();
  } finally {
    result.unmount();
    result.transport.dispose();
  }
});
