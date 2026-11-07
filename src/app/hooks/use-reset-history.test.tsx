import { createMockTransport } from "@core/mock-transport";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { useResetHistory } from "./use-reset-history";

afterEach(() => vi.restoreAllMocks());

function ResetProbe() {
  const { reset, resetting } = useResetHistory();
  const [outcome, setOutcome] = useState("none");
  return (
    <>
      <button
        type="button"
        disabled={resetting}
        onClick={() => void reset().then((ok) => setOutcome(String(ok)))}
      >
        Reset history
      </button>
      <output>{outcome}</output>
    </>
  );
}

it("settles resetting and resolves false when the reset call rejects", async () => {
  const transport = createMockTransport({ autoTick: false });
  vi.spyOn(transport, "resetHistory").mockRejectedValue(
    new Error("ipc closed")
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = vi.spyOn(toast, "error");
  const { user } = renderWithProviders(<ResetProbe />, { transport });
  await user.click(screen.getByRole("button", { name: "Reset history" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("false")
  );
  expect(screen.getByRole("button", { name: "Reset history" })).toBeEnabled();
  expect(error).toHaveBeenCalledWith("Couldn't reset history.");
  expect(log).toHaveBeenCalledWith(
    "[command] reset_history failed",
    expect.objectContaining({ hostId: expect.any(String) })
  );
});

it("names the other StatGlass when the store is busy", async () => {
  const transport = createMockTransport({ autoTick: false });
  vi.spyOn(transport, "resetHistory").mockResolvedValue({
    status: "error",
    error: { kind: "store_busy", message: "locked" },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const error = vi.spyOn(toast, "error");
  const { user } = renderWithProviders(<ResetProbe />, { transport });
  await user.click(screen.getByRole("button", { name: "Reset history" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("false")
  );
  expect(error).toHaveBeenCalledWith(
    "Another copy of StatGlass has the history file open. Quit it and try again."
  );
});

it("resolves true and confirms a reset", async () => {
  const success = vi.spyOn(toast, "success");
  const { user, transport } = renderWithProviders(<ResetProbe />);
  await user.click(screen.getByRole("button", { name: "Reset history" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("true")
  );
  expect(transport.calls.map((c) => c.command)).toContain("reset_history");
  expect(success).toHaveBeenCalledWith(
    "History reset. The old file was kept aside."
  );
});
