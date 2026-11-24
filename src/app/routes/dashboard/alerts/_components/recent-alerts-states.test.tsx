import type { Event } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { HOUR_MS } from "@core/time-grid";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { RecentAlerts } from "./recent-alerts";

const EMPTY_TEXT = "No alerts in the last 7 days.";

function processAlert(tsMs: number, process: string): Event {
  return {
    ts_ms: tsMs,
    start_ms: tsMs - 5 * 60_000,
    processes: [process],
    detail: {
      kind: "alert",
      rule_id: "6b656c76-6f00-0000-0000-000000000001",
      rule_name: "Process above 200% CPU for 5 minutes",
      cause: { type: "process_cpu", process, cpu_pct: 230 },
    },
  };
}

/** The store answers `events` for every read, as if it held only them. */
function holding(transport: MockTransport, events: Event[]) {
  transport.queryEvents = async (_host, fromMs, toMs) => ({
    status: "ok",
    data: events.filter((e) => e.ts_ms >= fromMs && e.ts_ms < toMs),
  });
}

async function trimHistoryBefore(transport: MockTransport, fromMs: number) {
  const health = await transport.historyHealth(MOCK_HOST_ID);
  if (health.status === "error") throw new Error(JSON.stringify(health.error));
  transport.setHistoryHealth({ ...health.data, trimmed_before_ms: fromMs });
}

describe("Recent alerts states", () => {
  it("says the alerts could not be loaded when the read fails, not that there were none", async () => {
    const transport = createMockTransport({ autoTick: false });
    transport.queryEvents = async () => ({
      status: "error",
      error: {
        kind: "store_busy",
        message: "history.sqlite is locked by another StatGlass process",
      },
    });
    renderWithProviders(<RecentAlerts />, { transport });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load alerts"
    );
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it("disables an alert whose history is no longer kept and says why", async () => {
    const transport = createMockTransport({ autoTick: false });
    const now = Date.now();
    holding(transport, [
      processAlert(now - 10 * HOUR_MS, "trimmed-job"),
      processAlert(now - HOUR_MS, "kept-job"),
    ]);
    await trimHistoryBefore(transport, now - 5 * HOUR_MS);
    renderWithProviders(<RecentAlerts />, { transport });
    const region = await screen.findByRole("region", { name: "Recent" });
    // The trim is known once the store's health answers.
    await waitFor(() =>
      expect(
        within(region).getByRole("button", { name: /trimmed-job/ })
      ).toBeDisabled()
    );
    expect(
      within(region).getByRole("button", { name: /trimmed-job/ })
    ).toHaveAccessibleDescription(
      "The history from this time is no longer kept"
    );
    const kept = within(region).getByRole("button", { name: /kept-job/ });
    expect(kept).toBeEnabled();
    expect(kept).toHaveAccessibleDescription("Open in Timeline");
  });
});
