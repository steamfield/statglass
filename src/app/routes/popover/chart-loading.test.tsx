import { createMockTransport } from "@core/mock-transport";
import { act } from "@testing-library/react";
import { mockElementAnimate, renderWithProviders } from "@tests/test-utils";
import { flushSync } from "react-dom";
import {
  LiveCpuCard,
  LiveGpuCard,
  LiveNetworkCard,
  LivePowerCard,
} from "./_components/popover-cards";

it("keeps a hidden warm popover quiet, reveals on first show, and retains data on reshow", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({ autoTick: false, historyRows: 120 });
  const animate = mockElementAnimate();
  document.documentElement.style.setProperty("--motion-enter", "280ms");
  transport.setWindowVisible(false);
  const subscribe = transport.subscribeLive;
  let showing = false;
  let sawPlan = false;
  vi.spyOn(transport, "subscribeLive").mockImplementation(
    (host, onMsg, options) =>
      subscribe(
        host,
        (message) => {
          if (!showing) {
            onMsg(message);
            return;
          }
          // Model separate channel messages so React commits the plan before its rows.
          flushSync(() => onMsg(message));
          if (message.kind === "backfill_plan") {
            sawPlan = true;
            expect(
              r.container.querySelectorAll("[data-chart-loading]")
            ).toHaveLength(4);
            expect(r.container.querySelector("path[data-line]")).toBeNull();
            expect(r.container.querySelector("[data-gap]")).toBeNull();
          }
        },
        options
      )
  );
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
    expect(animate).not.toHaveBeenCalled();
    showing = true;
    act(() => transport.setWindowVisible(true));
    showing = false;
    expect(sawPlan).toBe(true);
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    expect(animate).toHaveBeenCalledTimes(4);
    const layers = [...r.container.querySelectorAll("[data-reveal]")];
    expect(animate.mock.contexts).toEqual(expect.arrayContaining(layers));
    act(() => transport.setWindowVisible(false));
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    act(() => transport.setWindowVisible(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    expect([...r.container.querySelectorAll("[data-reveal]")]).toEqual(layers);
    expect(animate).toHaveBeenCalledTimes(4);
  } finally {
    r.unmount();
    transport.dispose();
    document.documentElement.style.removeProperty("--motion-enter");
    vi.useRealTimers();
  }
});
