import { createMockTransport } from "@core/mock-transport";
import { render, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "./app";

/** The backfill the popover's first `subscribe_live` asked for. */
async function popoverBackfill(
  scenarios: ("default" | "low-power-mode")[],
  appearanceFails = false
) {
  const transport = createMockTransport({
    windowLabel: "popover",
    scenarios,
    autoTick: false,
  });
  if (appearanceFails)
    transport.getWindowAppearance = () =>
      Promise.reject(new Error("ipc closed"));
  const r = render(
    <App transport={transport} router={{ initialEntry: "/popover" }} />
  );
  let backfill: unknown;
  await waitFor(() => {
    const call = transport.calls.find((c) => c.command === "subscribe_live");
    expect(call).toBeDefined();
    backfill = call?.args[1];
  });
  r.unmount();
  return backfill;
}

describe("popover backfill (D-088)", () => {
  it("covers 60 samples at the interval Low Power Mode doubles", async () => {
    expect(await popoverBackfill(["default"])).toBe(60_000);
    expect(await popoverBackfill(["low-power-mode"])).toBe(120_000);
  });

  it("a failed appearance read counts as not in Low Power Mode", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(await popoverBackfill(["low-power-mode"], true)).toBe(60_000);
    expect(error).toHaveBeenCalledWith(
      "[appearance] get_window_appearance failed",
      expect.any(Error)
    );
    error.mockRestore();
  });
});
