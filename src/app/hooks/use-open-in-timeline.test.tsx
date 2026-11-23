import { BRUSH_STEP_MS } from "@core/brush";
import { eventRange } from "@core/events";
import type { Event } from "@core/generated/bindings";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { vi } from "vitest";
import { HostClockContext } from "~/lib/host-clock";
import { useOpenInTimeline } from "./use-open-in-timeline";

const NOW = 1_800_000_000_000;

function fanEvent(agoMs: number): Event {
  return {
    ts_ms: NOW - agoMs,
    start_ms: NOW - agoMs - MINUTE_MS,
    processes: [],
    detail: { kind: "fans_ramped", from_rpm: 1400, to_rpm: 4200 },
  };
}

/** A link built on the hook, as a list row would build it. */
function OpenLink({ event }: { event: Event }) {
  const { rangeFor, open, pending } = useOpenInTimeline();
  const range = rangeFor(event);
  return (
    <button
      type="button"
      disabled={pending || range === null}
      onClick={() => {
        if (range) void open(range);
      }}
    >
      Open
    </button>
  );
}

function render(event: Event, transport: MockTransport) {
  return renderWithProviders(
    <HostClockContext.Provider value={() => NOW}>
      <OpenLink event={event} />
    </HostClockContext.Provider>,
    { transport, route: "/dashboard/alerts" }
  );
}

async function chartWindow(transport: MockTransport) {
  return (await transport.getSettings()).settings.general.chart_window;
}

describe("useOpenInTimeline", () => {
  it("saves the event's range, then opens the Timeline", async () => {
    const event = fanEvent(HOUR_MS);
    const transport = createMockTransport({ autoTick: false, now: () => NOW });
    const { user, router } = render(event, transport);
    await user.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/dashboard/timeline")
    );
    const range = eventRange([event], BRUSH_STEP_MS, NOW);
    if (!range) throw new Error("expected a range");
    expect(await chartWindow(transport)).toEqual({
      absolute: { from_ms: range.fromMs, to_ms: range.toMs },
    });
  });

  it("stays put when the range cannot be saved", async () => {
    const transport = createMockTransport({ autoTick: false, now: () => NOW });
    const { user, router } = render(fanEvent(HOUR_MS), transport);
    await screen.findByRole("button", { name: "Open" });
    transport.updateSettings = async () => ({
      status: "error",
      error: { kind: "settings_not_saved", message: "disk full" },
    });
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open" })).toBeEnabled()
    );
    expect(router.state.location.pathname).toBe("/dashboard/alerts");
  });

  it("opens the Timeline without a save when the range is already active", async () => {
    const event = fanEvent(HOUR_MS);
    const range = eventRange([event], BRUSH_STEP_MS, NOW);
    if (!range) throw new Error("expected a range");
    const transport = createMockTransport({
      autoTick: false,
      now: () => NOW,
      chartWindow: { absolute: { from_ms: range.fromMs, to_ms: range.toMs } },
    });
    const save = vi.spyOn(transport, "updateSettings");
    const { user, router } = render(event, transport);
    await user.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/dashboard/timeline")
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("gives no range for an event before the retained history", async () => {
    const transport = createMockTransport({ autoTick: false, now: () => NOW });
    const health = await transport.historyHealth(MOCK_HOST_ID);
    if (health.status === "error") throw new Error("expected health");
    render(fanEvent(10 * HOUR_MS), transport);
    const open = await screen.findByRole("button", { name: "Open" });
    expect(open).toBeEnabled();
    act(() =>
      transport.setHistoryHealth({
        ...health.data,
        trimmed_before_ms: NOW - 5 * HOUR_MS,
      })
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open" })).toBeDisabled()
    );
  });
});
