import { createMockTransport } from "@core/mock-transport";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useLastWake, useMax24h } from "./use-overview-history";

function Probe() {
  const max = useMax24h("power", "power.gpu");
  const { health, error } = useHistoryHealth();
  const state = error ? error.kind : health ? "healthy" : "loading";
  return (
    <p>
      {state} {max === undefined ? "none" : "max"}
    </p>
  );
}

describe("useMax24h", () => {
  it("has a 24 h maximum from history", async () => {
    const transport = createMockTransport({ autoTick: false });
    renderWithProviders(<Probe />, { transport });
    await screen.findByText("healthy max");
  });

  it("has none with history unavailable, though Rust answers from the last hour", async () => {
    const transport = createMockTransport({
      autoTick: false,
      scenarios: ["history-unavailable"],
    });
    renderWithProviders(<Probe />, { transport });
    await screen.findByText(/history_unavailable/);
    // The read itself answers (the engine's last hour).
    await vi.waitFor(() =>
      expect(
        transport.calls.some((c) => c.command === "query_series_stats")
      ).toBe(true)
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("history_unavailable none")).toBeTruthy();
  });
});

function Wake() {
  const wake = useLastWake();
  return <p>{wake === null ? "no wake" : `woke ${wake}`}</p>;
}

describe("useLastWake", () => {
  it("asks Rust for the last wake instead of probing a series", async () => {
    const transport = createMockTransport({ autoTick: false });
    renderWithProviders(<Wake />, { transport });
    await screen.findByText(/^woke \d+$/);
    expect(transport.calls.some((c) => c.command === "last_wake")).toBe(true);
    expect(transport.calls.some((c) => c.command === "query_history")).toBe(
      false
    );
  });

  it("has none with history unavailable", async () => {
    const transport = createMockTransport({
      autoTick: false,
      scenarios: ["history-unavailable"],
    });
    renderWithProviders(<Wake />, { transport });
    await vi.waitFor(() =>
      expect(transport.calls.some((c) => c.command === "last_wake")).toBe(true)
    );
    expect(screen.getByText("no wake")).toBeTruthy();
  });
});
