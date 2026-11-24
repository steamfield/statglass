import { alertLabel } from "@core/events";
import { formatClock } from "@core/format";
import type { Event } from "@core/generated/types";
import { MOCK_HOST_ID, type ScenarioName } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { HOUR_MS } from "@core/time-grid";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { RecentAlerts } from "./recent-alerts";

const EMPTY_TEXT = "No alerts in the last 7 days.";

function recentRegion() {
  return screen.getByRole("region", { name: "Recent" });
}

async function storedEvents(transport: MockTransport): Promise<Event[]> {
  const answer = await transport.queryEvents(
    MOCK_HOST_ID,
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (answer.status === "error") throw new Error(JSON.stringify(answer.error));
  return answer.data;
}

/** The store answers `events` for every read, as if it held only them. */
function holding(transport: MockTransport, events: Event[]) {
  transport.queryEvents = async (_host, fromMs, toMs) => ({
    status: "ok",
    data: events.filter((e) => e.ts_ms >= fromMs && e.ts_ms < toMs),
  });
}

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

function thresholdAlert(tsMs: number, metric: string, value: number): Event {
  return {
    ts_ms: tsMs,
    start_ms: tsMs - 2 * 60_000,
    processes: [],
    detail: {
      kind: "alert",
      rule_id: "c0ffee00-0000-4000-8000-0000000000a1",
      rule_name: "Watch this",
      cause: {
        type: "threshold",
        metric,
        labels: [],
        value,
        op: "gt",
        threshold: value / 2,
        for_secs: 120,
      },
    },
  };
}

describe("Recent alerts", () => {
  it("lists each alert with its time and label, newest first, and no other events", async () => {
    const transport = createMockTransport({
      scenarios: ["alerts"],
      autoTick: false,
    });
    const alerts = (await storedEvents(transport))
      .filter((e) => e.detail.kind === "alert")
      .sort((a, b) => b.ts_ms - a.ts_ms);
    expect(alerts).toHaveLength(2);
    renderWithProviders(<RecentAlerts />, { transport });
    const items = await waitFor(() => {
      const found = within(recentRegion()).getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
    alerts.forEach((alert, i) => {
      const item = items[i];
      expect(item).toHaveTextContent(formatClock(alert.ts_ms));
      expect(item).toHaveTextContent(alertLabel(alert, null));
    });
    // A list of alerts does not say "Alert" on every line.
    expect(items[0]).toHaveTextContent(/^Memory pressure 86%/);
    expect(items[1]).toHaveTextContent(/^ffmpeg at 251% CPU/);
  });

  it("writes threshold values in the user's units", async () => {
    const transport = createMockTransport({ autoTick: false });
    const saved = await transport.updateSettings({
      units: { temperature: "celsius", memory: "binary" },
    });
    if (saved.status === "error") throw new Error(JSON.stringify(saved.error));
    const now = Date.now();
    holding(transport, [
      thresholdAlert(now - 2 * HOUR_MS, "thermal.hottest", 96),
      thresholdAlert(now - HOUR_MS, "mem.swap_used", 5 * 2 ** 30),
    ]);
    renderWithProviders(<RecentAlerts />, { transport });
    const items = await waitFor(() => {
      const found = within(recentRegion()).getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
    expect(items[0]).toHaveTextContent(/^Swap used 5 GiB/);
    expect(items[1]).toHaveTextContent(/^Hottest sensor 96 °C/);
  });

  it("lists a saved host going offline and coming back", async () => {
    const transport = createMockTransport({
      scenarios: ["mac-offline"],
      autoTick: false,
    });
    renderWithProviders(<RecentAlerts />, { transport });
    const region = await screen.findByRole("region", { name: "Recent" });
    expect(
      await within(region).findByText("Studio Mac is back after 42 min")
    ).toBeInTheDocument();
    expect(
      within(region).getByText("Studio Mac is offline")
    ).toBeInTheDocument();
  });

  it("shows at most the 20 newest", async () => {
    const transport = createMockTransport({ autoTick: false });
    const now = Date.now();
    // Oldest first, as the store answers.
    const events = Array.from({ length: 25 }, (_, i) =>
      processAlert(now - (25 - i) * HOUR_MS, `job-${i + 1}`)
    );
    holding(transport, events);
    renderWithProviders(<RecentAlerts />, { transport });
    const items = await waitFor(() => {
      const found = within(recentRegion()).getAllByRole("listitem");
      expect(found).toHaveLength(20);
      return found;
    });
    expect(items[0]).toHaveTextContent("job-25");
    expect(items[19]).toHaveTextContent("job-6");
  });

  it("opens the Timeline at an alert", async () => {
    const transport = createMockTransport({
      scenarios: ["alerts"],
      autoTick: false,
    });
    const newest = (await storedEvents(transport))
      .filter((e) => e.detail.kind === "alert")
      .sort((a, b) => b.ts_ms - a.ts_ms)[0];
    if (!newest) throw new Error("the alerts scenario seeds no alert");
    const { user, router } = renderWithProviders(<RecentAlerts />, {
      transport,
      route: "/dashboard/alerts",
    });
    await user.click(await screen.findByText(alertLabel(newest, null)));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/dashboard/timeline")
    );
    const window = (await transport.getSettings()).settings.general
      .chart_window;
    if (typeof window !== "object" || !("absolute" in window)) {
      throw new Error(`expected an absolute range, got ${String(window)}`);
    }
    expect(window.absolute.from_ms).toBeLessThanOrEqual(newest.ts_ms);
    expect(window.absolute.to_ms).toBeGreaterThan(newest.ts_ms);
  });

  it.each([
    ["no alerts", [] as ScenarioName[], true],
    [
      "history is unavailable",
      ["history-unavailable"] as ScenarioName[],
      false,
    ],
  ])("says so when there are %s", async (_case, scenarios, empty) => {
    const transport = createMockTransport({ scenarios, autoTick: false });
    if (empty) holding(transport, []);
    renderWithProviders(<RecentAlerts />, { transport });
    expect(await screen.findByText(EMPTY_TEXT)).toBeVisible();
    expect(within(recentRegion()).queryAllByRole("listitem")).toHaveLength(0);
  });
});
