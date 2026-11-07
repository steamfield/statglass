import { createMockTransport } from "@core/mock-transport";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { useWriteSettings } from "./use-write-settings";

afterEach(() => vi.restoreAllMocks());

function WriteProbe() {
  const write = useWriteSettings();
  return (
    <button
      type="button"
      onClick={() => write({ cli_access: { enabled: false } })}
    >
      Write
    </button>
  );
}

it("says why when the settings call rejects", async () => {
  const transport = createMockTransport({ autoTick: false });
  vi.spyOn(transport, "updateSettings").mockRejectedValue(
    new Error("ipc closed")
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = vi.spyOn(toast, "error");
  const { user } = renderWithProviders(<WriteProbe />, { transport });
  await user.click(screen.getByRole("button", { name: "Write" }));
  await waitFor(() =>
    expect(error).toHaveBeenCalledWith(
      "Couldn't change settings. Nothing changed."
    )
  );
  expect(log).toHaveBeenCalledWith("[settings] update_settings failed", {
    patch: { cli_access: { enabled: false } },
    error: expect.any(Error),
  });
});
