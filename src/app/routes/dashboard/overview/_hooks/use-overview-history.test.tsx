import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { historyKeys } from "@core/query-keys";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useLastWake } from "./use-overview-history";

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
    const { queryClient } = renderWithProviders(<Wake />, { transport });
    // Settled, not pending: Rust refused the read.
    await vi.waitFor(() =>
      expect(
        queryClient.getQueryState(historyKeys.lastWake(MOCK_HOST_ID))?.status
      ).toBe("error")
    );
    expect(screen.getByText("no wake")).toBeTruthy();
  });
});
