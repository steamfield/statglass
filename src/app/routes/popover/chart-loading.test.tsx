import { createMockTransport } from "@core/mock-transport";
import { act } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import {
  LiveCpuCard,
  LiveGpuCard,
  LiveNetworkCard,
  LivePowerCard,
} from "./_components/popover-cards";

it("keeps a hidden warm popover quiet, reveals on first show, and retains data on reshow", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  transport.setWindowVisible(false);
  const r = renderWithProviders(
    <>
      <LiveCpuCard onToggle={() => {}} />
      <LiveGpuCard onToggle={() => {}} />
      <LiveNetworkCard onToggle={() => {}} />
      <LivePowerCard compact onToggle={() => {}} />
    </>,
    { transport }
  );
  try {
    await act(async () => {});
    expect(
      transport.calls.filter((call) => call.command === "subscribe_live")
    ).toHaveLength(1);
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    expect(r.container.querySelector("[class*='reveal']")).toBeNull();
    // Rust announces the catch-up on first show before delivering its rows.
    act(() => {
      transport.setWindowVisible(true);
      transport.push({
        kind: "backfill_plan",
        recent_rows: 60,
        earlier_start_ms: null,
      });
    });
    expect(r.container.querySelectorAll("[data-chart-loading]")).toHaveLength(
      4
    );
    expect(r.container.querySelector("path[data-line]")).toBeNull();
    expect(r.container.querySelector("[data-gap]")).toBeNull();
    act(() => transport.tick());
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    expect(r.container.querySelectorAll("[class*='reveal']")).toHaveLength(4);
    const layers = [...r.container.querySelectorAll("[class*='reveal']")];
    const classes = layers.map((layer) => layer.getAttribute("class"));
    act(() => transport.setWindowVisible(false));
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    act(() => transport.setWindowVisible(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    // Held data layers keep their identities and animation classes, so no entrance restarts.
    expect([...r.container.querySelectorAll("[class*='reveal']")]).toEqual(
      layers
    );
    expect(layers.map((layer) => layer.getAttribute("class"))).toEqual(classes);
  } finally {
    r.unmount();
    transport.dispose();
    vi.useRealTimers();
  }
});
